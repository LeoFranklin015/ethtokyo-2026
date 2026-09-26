// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EnhancedAccessControl} from "@ens-v2/access-control/EnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";

interface IBranchResolver {
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @title ModularBranchRegistrar — PROTOTYPE
/// @notice Org-defined roles, with per-key record permissions, expressed natively in EAC.
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
contract ModularBranchRegistrar is EnhancedAccessControl {
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

    mapping(bytes32 roleId => RoleSpec) public roleSpec;
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

    error Reentrancy();
    error UnknownRole(bytes32 roleId);
    error CannotMintRole(address account, bytes32 roleId);
    error CannotEditKey(address account, string key);
    error NotARoleEditor(address account);
    error LabelUnavailable(string label);
    error AlreadyOnboarded(address account);
    error NotOnboarded(address account);

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
        address admin
    ) {
        REGISTRY = registry;
        RESOLVER = resolver;
        BRANCH_EXPIRY = branchExpiry;
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
        string[] calldata editableKeys
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
        emit RoleDefined(id, name);
    }

    ////////////////////////////////////////////////////////////////////////
    // Lifecycle
    ////////////////////////////////////////////////////////////////////////

    function onboard(string calldata label, address owner, bytes32 role)
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

        uint256 tokenId = REGISTRY.register(
            label, owner, IRegistry(address(0)), address(RESOLVER), spec.registryBitmap, BRANCH_EXPIRY
        );
        resource = REGISTRY.getResource(tokenId);

        roleOf[resource] = role;
        memberOf[resource] = owner;
        membershipOf[owner] = resource;
        labelOf[resource] = label;

        emit Onboarded(resource, label, owner, role);
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

        uint256 membership = membershipOf[account];
        if (membership == 0) return roleBitmap;

        RoleSpec storage holder = roleSpec[roleOf[membership]];
        if (!holder.active) return roleBitmap;

        // Minting: does the caller's role confer onboarding, and is the target role open?
        bytes32 targetRole = roleAtResource[resource];
        if (targetRole != bytes32(0) && holder.canOnboard && roleSpec[targetRole].openToOnboarders) {
            roleBitmap |= ROLE_MINT;
        }

        // Records: does the caller's role list this key as self-editable?
        bytes32 keyHash = keyAtResource[resource];
        if (keyHash != bytes32(0) && selfEditable[roleOf[membership]][keyHash]) {
            roleBitmap |= ROLE_EDIT_RECORD;
        }
    }
}
