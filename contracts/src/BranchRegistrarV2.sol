// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EnhancedAccessControl} from "@ens-v2/access-control/EnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {OrgRegistrar} from "./OrgRegistrar.sol";

interface IBranchResolver {
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @title BranchRegistrarV2
/// @notice The complete branch layer: org-defined roles, per-key record permissions, entitlements
///         written at onboarding, and the Member link that makes identity survive a branch.
///
/// @dev Two ideas, both of which fall out of EAC rather than being bolted beside it.
///
///      **Roles and record keys are EAC _resources_, not EAC _roles_.** EAC allows 2^256 resources
///      but only 32 role bits, so modelling a custom role as a role bit caps an organization at 32
///      of them. Modelling it as a resource removes the ceiling entirely, and the paired admin role
///      then means "may delegate minting of *this* role" for free.
///
///      **Authority is derived in `_getRoles`, not granted per account.** EAC enforces its
///      15-assignee ceiling inside `_grantRoles` by incrementing `_roleCount`. A role computed by
///      an overridden `_getRoles` never touches that counter, so an organization can have any
///      number of volunteers. It also means authority follows the membership: promote someone and
///      they can onboard in the same transaction, demote them and the power is gone — with no
///      second grant to remember to revoke. This is the pattern `PermissionedRegistry` already uses
///      to let ERC1155 operators inherit an owner's roles.
contract BranchRegistrarV2 is EnhancedAccessControl {
    ////////////////////////////////////////////////////////////////////////
    // Verbs. The 32 role slots hold actions; the roles an org invents are resources.
    ////////////////////////////////////////////////////////////////////////

    /// @dev Scoped to a role resource: "may mint memberships at this role".
    uint256 public constant ROLE_MINT = 1 << 0;
    uint256 public constant ROLE_MINT_ADMIN = ROLE_MINT << 128;

    /// @dev Scoped to a key resource: "may write this text record".
    uint256 public constant ROLE_EDIT_RECORD = 1 << 4;
    uint256 public constant ROLE_EDIT_RECORD_ADMIN = ROLE_EDIT_RECORD << 128;

    /// @dev Root only: "may define and retire roles".
    uint256 public constant ROLE_ROLE_EDIT = 1 << 8;
    uint256 public constant ROLE_ROLE_EDIT_ADMIN = ROLE_ROLE_EDIT << 128;

    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct Entitlement {
        string key;
        string value;
    }

    struct RoleSpec {
        /// Registry roles the holder gets over their own name.
        uint256 registryBitmap;
        /// Holders may mint any role flagged `openToOnboarders`.
        bool canOnboard;
        /// This role may be minted by any `canOnboard` holder, not only named delegates.
        bool openToOnboarders;
        bool active;
    }

    IPermissionedRegistry public immutable REGISTRY;
    IBranchResolver public immutable RESOLVER;
    uint64 public immutable BRANCH_EXPIRY;

    /// @notice The organization's Member layer. Onboarding here enrols there first.
    OrgRegistrar public immutable ORG;

    /// @notice ENS namehash of this branch, e.g. `namehash("tokyo.ethglobal2.eth")`.
    /// @dev Held on-chain so the registrar writes records at the membership's true namehash.
    ///      Hashing only the label produces a node nothing resolves to — the write succeeds and
    ///      then reads back empty through the UniversalResolver.
    bytes32 public immutable BRANCH_NODE;

    mapping(bytes32 roleId => RoleSpec) public roleSpec;
    /// @dev Records written to every membership minted at this role.
    mapping(bytes32 roleId => Entitlement[]) internal _entitlements;
    /// @dev Text keys a role's holder may write **on their own name**.
    mapping(bytes32 roleId => mapping(bytes32 keyHash => bool)) public selfEditable;

    /// @dev Reverse lookups, so `_getRoles` can tell what an opaque resource refers to.
    mapping(uint256 resource => bytes32 roleId) public roleAtResource;
    mapping(uint256 resource => bytes32 keyHash) public keyAtResource;

    mapping(uint256 membershipResource => bytes32 roleId) public roleOf;
    mapping(uint256 membershipResource => address member) public memberOf;
    mapping(address account => uint256 membershipResource) public membershipOf;
    mapping(uint256 membershipResource => string label) public labelOf;

    uint256 private _entered;

    event RoleDefined(bytes32 indexed roleId, string name);
    event Onboarded(uint256 indexed resource, string label, address indexed owner, bytes32 roleId);
    event RecordSet(uint256 indexed resource, string key, string value);
    event Revoked(uint256 indexed resource, address indexed member);

    error Reentrancy();
    error UnknownRole(bytes32 roleId);
    error CannotMintRole(address account, bytes32 roleId);
    error CannotEditKey(address account, string key);
    error NotARoleEditor(address account);
    error LabelUnavailable(string label);
    error AlreadyOnboarded(address account);
    error NotOnboarded(address account);
    error NotARevoker(address account);

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(
        IPermissionedRegistry registry,
        IBranchResolver resolver,
        uint64 branchExpiry,
        address admin,
        OrgRegistrar org,
        bytes32 branchNode
    ) {
        REGISTRY = registry;
        RESOLVER = resolver;
        BRANCH_EXPIRY = branchExpiry;
        ORG = org;
        BRANCH_NODE = branchNode;
        _grantRoles(
            ROOT_RESOURCE,
            ROLE_MINT | ROLE_MINT_ADMIN | ROLE_EDIT_RECORD | ROLE_EDIT_RECORD_ADMIN | ROLE_ROLE_EDIT
                | ROLE_ROLE_EDIT_ADMIN,
            admin,
            false
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Resource scheme — namespaced so a role id can never collide with a key id
    ////////////////////////////////////////////////////////////////////////

    function roleResource(bytes32 roleId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode("ensca.role", roleId)));
    }

    function keyResource(string memory key) public pure returns (uint256) {
        return uint256(keccak256(abi.encode("ensca.key", keccak256(bytes(key)))));
    }

    function roleId(string memory name) public pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    ////////////////////////////////////////////////////////////////////////
    // The catalogue — data an organization edits, not code it deploys
    ////////////////////////////////////////////////////////////////////////

    /// @param editableKeys Text keys this role's holders may write on their own name.
    function defineRole(
        string calldata name,
        uint256 registryBitmap,
        bool canOnboard,
        bool openToOnboarders,
        string[] calldata editableKeys,
        Entitlement[] calldata grants
    ) external {
        if (!hasRootRoles(ROLE_ROLE_EDIT, msg.sender)) revert NotARoleEditor(msg.sender);

        bytes32 id = roleId(name);
        roleSpec[id] = RoleSpec(registryBitmap, canOnboard, openToOnboarders, true);
        roleAtResource[roleResource(id)] = id;

        for (uint256 i; i < editableKeys.length; ++i) {
            bytes32 keyHash = keccak256(bytes(editableKeys[i]));
            selfEditable[id][keyHash] = true;
            keyAtResource[keyResource(editableKeys[i])] = keyHash;
        }
        delete _entitlements[id];
        for (uint256 i; i < grants.length; ++i) {
            _entitlements[id].push(grants[i]);
        }
        emit RoleDefined(id, name);
    }

    function entitlementsOf(bytes32 role) external view returns (Entitlement[] memory) {
        return _entitlements[role];
    }

    /// @notice ENS namehash of a membership in this branch.
    function membershipNode(string memory label) public view returns (bytes32) {
        return keccak256(abi.encodePacked(BRANCH_NODE, keccak256(bytes(label))));
    }

    ////////////////////////////////////////////////////////////////////////
    // Lifecycle
    ////////////////////////////////////////////////////////////////////////

    /// @param memberLabel The person's organization-wide label. Ignored if already a Member.
    function onboard(string calldata label, address owner, bytes32 role, string calldata memberLabel)
        external
        nonReentrant
        returns (uint256 resource)
    {
        RoleSpec memory spec = roleSpec[role];
        if (!spec.active) revert UnknownRole(role);

        // One check covers every case: a named delegate for this role, an org-wide minter via
        // ROOT_RESOURCE, or a member whose own role confers minting (derived in `_getRoles`).
        if (!hasRoles(roleResource(role), ROLE_MINT, msg.sender)) {
            revert CannotMintRole(msg.sender, role);
        }
        if (membershipOf[owner] != 0) revert AlreadyOnboarded(owner);
        if (REGISTRY.getStatus(uint256(keccak256(bytes(label)))) != IPermissionedRegistry.Status.AVAILABLE) {
            revert LabelUnavailable(label);
        }

        // The Member name is minted once, at a person's first onboarding anywhere in the
        // organization. Every later branch reuses it, which is what carries identity across
        // venues rather than stranding it in one branch.
        if (address(ORG) != address(0)) {
            ORG.ensureMember(bytes(memberLabel).length == 0 ? label : memberLabel, owner);
        }

        uint256 tokenId = REGISTRY.register(
            label, owner, IRegistry(address(0)), address(RESOLVER), spec.registryBitmap, BRANCH_EXPIRY
        );
        resource = REGISTRY.getResource(tokenId);

        roleOf[resource] = role;
        memberOf[resource] = owner;
        membershipOf[owner] = resource;
        labelOf[resource] = label;

        // A membership is complete in one transaction: the name exists and its entitlements are
        // already resolvable. Nothing has to remember to write them afterwards.
        bytes32 node = membershipNode(label);
        Entitlement[] storage grants = _entitlements[role];
        for (uint256 i; i < grants.length; ++i) {
            RESOLVER.setText(node, grants[i].key, grants[i].value);
        }

        emit Onboarded(resource, label, owner, role);
    }

    /// @notice End a membership: free the name and clear the records it published.
    /// @dev `docs/13` §5.5 — *"Revoke all roles on Membership resource, clear records. Member name
    ///      survives; only Membership ends."* Clearing matters because the resolver keeps records
    ///      keyed by namehash even after the registry forgets the name.
    function revoke(uint256 anyId) external nonReentrant {
        if (!hasRootRoles(ROLE_EDIT_RECORD, msg.sender)) revert NotARevoker(msg.sender);

        uint256 resource = REGISTRY.getResource(anyId);
        address member = memberOf[resource];
        if (member == address(0)) member = memberOf[anyId];
        if (member == address(0)) revert NotOnboarded(msg.sender);
        if (memberOf[anyId] != address(0)) resource = anyId;

        string memory label = labelOf[resource];
        bytes32 node = membershipNode(label);
        Entitlement[] storage grants = _entitlements[roleOf[resource]];
        for (uint256 i; i < grants.length; ++i) {
            RESOLVER.setText(node, grants[i].key, "");
        }

        if (REGISTRY.getStatus(resource) != IPermissionedRegistry.Status.AVAILABLE) {
            REGISTRY.unregister(resource);
        }

        delete roleOf[resource];
        delete memberOf[resource];
        delete membershipOf[member];
        emit Revoked(resource, member);
    }

    /// @notice The role that actually applies to `account` at this branch.
    /// @dev The resolution order from `docs/13` §5.4: a Membership here overrides everything;
    ///      otherwise the organization-wide role applies; otherwise nothing does.
    function effectiveRole(address account) public view returns (bytes32 role, bool fromOrg) {
        uint256 membership = membershipOf[account];
        if (membership != 0) return (roleOf[membership], false);
        if (address(ORG) != address(0)) {
            bytes32 orgRole = ORG.orgRole(account);
            if (orgRole != bytes32(0) && roleSpec[orgRole].active) return (orgRole, true);
        }
        return (bytes32(0), false);
    }

    /// @notice Write one of your own text records — if your role permits that key.
    ///
    /// @dev The resolver cannot express this on its own: its roles are argument-scoped but not
    ///      name-scoped, so granting a member `ROLE_SET_TEXT` for `wifi.rate` would let them edit
    ///      `wifi.rate` on *everyone's* name. The registrar holds the resolver role and mediates,
    ///      adding the per-name dimension the resolver lacks.
    function setOwnRecord(string calldata key, string calldata value, bytes32 node)
        external
        nonReentrant
    {
        uint256 resource = membershipOf[msg.sender];
        if (resource == 0) revert NotOnboarded(msg.sender);
        if (!hasRoles(keyResource(key), ROLE_EDIT_RECORD, msg.sender)) {
            revert CannotEditKey(msg.sender, key);
        }
        RESOLVER.setText(node, key, value);
        emit RecordSet(resource, key, value);
    }

    /// @notice Write a record on any membership. For staff, not members.
    function setRecord(uint256 resource, string calldata key, string calldata value, bytes32 node)
        external
    {
        if (!hasRootRoles(ROLE_EDIT_RECORD, msg.sender)) revert CannotEditKey(msg.sender, key);
        RESOLVER.setText(node, key, value);
        emit RecordSet(resource, key, value);
    }

    ////////////////////////////////////////////////////////////////////////
    // The hook — where authority is derived rather than stored
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc EnhancedAccessControl
    /// @dev Adds roles implied by the caller's own membership. Nothing here writes storage, so
    ///      none of it counts against EAC's 15-assignees-per-role-per-resource ceiling.
    function _getRoles(uint256 resource, address account)
        internal
        view
        override
        returns (uint256 roleBitmap)
    {
        roleBitmap = super._getRoles(resource, account);

        // Authority follows the effective role, so an organization-wide role works at every
        // branch without a per-branch grant — the fallback in `docs/13` §5.4, on-chain.
        (bytes32 holderRoleId,) = effectiveRole(account);
        if (holderRoleId == bytes32(0)) return roleBitmap;

        RoleSpec storage holder = roleSpec[holderRoleId];
        if (!holder.active) return roleBitmap;

        // Minting: does the caller's role confer onboarding, and is the target role open?
        bytes32 targetRole = roleAtResource[resource];
        if (targetRole != bytes32(0) && holder.canOnboard && roleSpec[targetRole].openToOnboarders) {
            roleBitmap |= ROLE_MINT;
        }

        // Records: does the caller's role list this key as self-editable?
        bytes32 keyHash = keyAtResource[resource];
        if (keyHash != bytes32(0) && selfEditable[holderRoleId][keyHash]) {
            roleBitmap |= ROLE_EDIT_RECORD;
        }
    }
}
