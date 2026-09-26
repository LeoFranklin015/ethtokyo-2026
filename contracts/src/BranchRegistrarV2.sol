// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EnhancedAccessControl} from "@ens-v2/access-control/EnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {OrgRegistrar} from "./OrgRegistrar.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

interface IBranchResolver {
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function text(bytes32 node, string calldata key) external view returns (string memory);
    /// @dev ENSv2's own per-(name, key) permission. Grants `ROLE_SET_TEXT` on
    ///      `resource(namehash(toName), partHash(key))`, so the resolver itself enforces both
    ///      dimensions. Caller needs `ROLE_SET_TEXT_ADMIN` on `resource(namehash(toName), 0)`.
    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool updated);
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

    /// @notice Roles this contract must hold at the branch registry's `ROOT_RESOURCE`.
    /// @dev Only what it actually calls: `register` to mint, `unregister` to revoke, `renew` to
    ///      extend. V2 sets a membership's registry bitmap at registration and never rewrites it,
    ///      so it needs none of the `_ADMIN` roles V1 required for `promote`.
    uint256 public constant REQUIRED_REGISTRY_ROLES = RegistryRolesLib.ROLE_REGISTRAR
        | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER;

    /// @dev Root only: "may define and retire roles".
    uint256 public constant ROLE_ROLE_EDIT = 1 << 8;
    uint256 public constant ROLE_ROLE_EDIT_ADMIN = ROLE_ROLE_EDIT << 128;

    /// @dev Root only: "may end a membership". Deliberately not `ROLE_EDIT_RECORD`: fixing a
    ///      typo in somebody's avatar and burning their name are not the same privilege, and the
    ///      record role is the one an organization hands out widely.
    uint256 public constant ROLE_REVOKE = 1 << 12;
    uint256 public constant ROLE_REVOKE_ADMIN = ROLE_REVOKE << 128;

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

    /// @notice DNS wire-format encoding of this branch, e.g. `\x05tokyo\x0aethglobal2\x03eth\x00`.
    /// @dev `authorizeTextRoles` takes a name, not a node, and re-derives the namehash itself.
    ///      Storing the encoding is what lets this contract delegate per-key rights on a
    ///      membership without the caller ever supplying a node.
    bytes public BRANCH_DNS_NAME;

    mapping(bytes32 roleId => RoleSpec) public roleSpec;
    /// @dev Records written to every membership minted at this role.
    mapping(bytes32 roleId => Entitlement[]) internal _entitlements;
    /// @dev Text keys a role's holder may write **on their own name**. Authority is not stored
    ///      here — it is delegated to the resolver at onboarding. This is the catalogue entry.
    mapping(bytes32 roleId => mapping(bytes32 keyHash => bool)) public selfEditable;
    /// @dev The same keys as a list, so `defineRole` can clear the previous set. Without it a
    ///      key removed from a role stays writable by its holders forever.
    mapping(bytes32 roleId => string[]) internal _editableKeys;

    /// @dev Reverse lookup, so `_getRoles` can tell what an opaque resource refers to.
    mapping(uint256 resource => bytes32 roleId) public roleAtResource;

    mapping(uint256 membershipResource => bytes32 roleId) public roleOf;
    mapping(uint256 membershipResource => address member) public memberOf;
    mapping(address account => uint256 membershipResource) public membershipOf;
    mapping(uint256 membershipResource => string label) public labelOf;
    /// @dev The keys actually delegated to this membership at onboarding. The role's list can
    ///      change afterwards, and teardown must revoke what was granted — not what the
    ///      catalogue happens to say today, or a dropped key stays live on a recycled label.
    mapping(uint256 membershipResource => string[]) internal _grantedKeys;

    uint256 private _entered;

    event RoleDefined(bytes32 indexed roleId, string name);
    event Onboarded(uint256 indexed resource, string label, address indexed owner, bytes32 roleId);
    event RecordSet(uint256 indexed resource, string key, string value);
    event Revoked(uint256 indexed resource, address indexed member);
    event RoleRetired(bytes32 indexed roleId);
    event MembershipReleased(address indexed account, uint256 resource);
    event MemberKeysSynced(uint256 indexed resource, address indexed member);

    error Reentrancy();
    error UnknownRole(bytes32 roleId);
    error CannotMintRole(address account, bytes32 roleId);
    error CannotEditKey(address account, string key);
    error NotARoleEditor(address account);
    error LabelUnavailable(string label);
    error AlreadyOnboarded(address account);
    error NotOnboarded(address account);
    error NotARevoker(address account);
    error InvalidLabel(string label);
    error InvalidOwner();
    error MembershipStillLive(address account);
    error ForbiddenRegistryRoles(uint256 bitmap);
    error NameNodeMismatch();

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
        bytes32 branchNode,
        bytes memory branchDnsName
    ) {
        REGISTRY = registry;
        RESOLVER = resolver;
        BRANCH_EXPIRY = branchExpiry;
        ORG = org;
        // If these two ever disagreed, `authorizeTextRoles` would delegate rights under a
        // namespace this contract never writes to — silently, and on a shared resolver.
        if (NameCoder.namehash(branchDnsName, 0) != branchNode) revert NameNodeMismatch();
        BRANCH_NODE = branchNode;
        BRANCH_DNS_NAME = branchDnsName;
        _grantRoles(
            ROOT_RESOURCE,
            ROLE_MINT | ROLE_MINT_ADMIN | ROLE_EDIT_RECORD | ROLE_EDIT_RECORD_ADMIN | ROLE_ROLE_EDIT
                | ROLE_ROLE_EDIT_ADMIN | ROLE_REVOKE | ROLE_REVOKE_ADMIN,
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

    function roleId(string memory name) public pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    ////////////////////////////////////////////////////////////////////////
    // The catalogue — data an organization edits, not code it deploys
    ////////////////////////////////////////////////////////////////////////

    /// @notice Registry roles a membership may never carry.
    /// @dev Memberships are soulbound and may not re-point their own name: transferring one
    ///      would move authority to a wallet the branch never admitted, and re-pointing the
    ///      subregistry or resolver would take the name outside the branch's control.
    /// @dev Blocking only the `_ADMIN` halves would stop a member *delegating* these onward
    ///      while leaving them free to use them: `setSubregistry` and `setResolver` check the
    ///      plain bit, and `unregister` would let a member self-destruct their name and strand
    ///      this contract's bookkeeping.
    uint256 public constant FORBIDDEN_REGISTRY_ROLES = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN
        | RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN
        | RegistryRolesLib.ROLE_SET_RESOLVER | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN
        | RegistryRolesLib.ROLE_UNREGISTER | RegistryRolesLib.ROLE_REGISTRAR;

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

        if (registryBitmap & FORBIDDEN_REGISTRY_ROLES != 0) revert ForbiddenRegistryRoles(registryBitmap);

        bytes32 id = roleId(name);
        roleSpec[id] = RoleSpec(registryBitmap, canOnboard, openToOnboarders, true);
        roleAtResource[roleResource(id)] = id;

        // Clear before writing. A redefinition that drops a key must actually drop it —
        // otherwise every existing holder keeps a permission the catalogue no longer lists.
        string[] storage previous = _editableKeys[id];
        for (uint256 i; i < previous.length; ++i) {
            selfEditable[id][keccak256(bytes(previous[i]))] = false;
        }
        delete _editableKeys[id];
        for (uint256 i; i < editableKeys.length; ++i) {
            bytes32 keyHash = keccak256(bytes(editableKeys[i]));
            selfEditable[id][keyHash] = true;
            _editableKeys[id].push(editableKeys[i]);
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

    /// @notice The text keys this role's holders may write on their own name.
    function editableKeysOf(bytes32 role) external view returns (string[] memory) {
        return _editableKeys[role];
    }

    /// @notice Retire a role. Existing memberships keep their name; nobody new can be minted at it.
    function retireRole(bytes32 role) external {
        if (!hasRootRoles(ROLE_ROLE_EDIT, msg.sender)) revert NotARoleEditor(msg.sender);
        roleSpec[role].active = false;
        emit RoleRetired(role);
    }

    /// @notice DNS wire-format name of a membership, e.g. `\x03leo\x05tokyo...`.
    /// @dev Derived here and never supplied, for the same reason `membershipNode` is: a
    ///      caller-chosen name is a caller-chosen namehash.
    function membershipDnsName(string memory label) public view returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, BRANCH_DNS_NAME);
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
        if (owner == address(0)) revert InvalidOwner();
        if (!_isValidLabel(label)) revert InvalidLabel(label);
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

        // Hand the member their own record rights, in the resolver's own terms: `ROLE_SET_TEXT`
        // on `resource(theirNode, partHash(key))`. They then call `setText` directly and the
        // resolver checks both dimensions — this contract never writes on their behalf again.
        _delegateKeys(resource, label, _editableKeys[role], owner, true);

        emit Onboarded(resource, label, owner, role);
    }

    /// @notice End a membership: free the name and clear the records it published.
    /// @dev `docs/13` §5.5 — *"Revoke all roles on Membership resource, clear records. Member name
    ///      survives; only Membership ends."* Clearing matters because the resolver keeps records
    ///      keyed by namehash even after the registry forgets the name.
    function revoke(uint256 anyId) external nonReentrant {
        if (!hasRootRoles(ROLE_REVOKE, msg.sender)) revert NotARevoker(msg.sender);

        uint256 resource = _resolveResource(anyId);
        address member = memberOf[resource];
        if (member == address(0)) revert NotOnboarded(member);

        _tearDown(resource, member);

        if (REGISTRY.getStatus(resource) != IPermissionedRegistry.Status.AVAILABLE) {
            REGISTRY.unregister(resource);
        }
        emit Revoked(resource, member);
    }

    /// @notice Clear a membership pointer that no longer matches the registry.
    ///
    /// @dev Needed because the registry can move out from under this contract: a root holder
    ///      calls `unregister` directly, or a label is re-registered and its `eacVersionId`
    ///      bumps. The stale pointer would otherwise pin `membershipOf[account]` forever and
    ///      lock that wallet out of ever being onboarded again.
    function releaseMembership(address account) external {
        uint256 resource = membershipOf[account];
        if (resource == 0) revert NotOnboarded(account);
        // Only if the registry disagrees that this is still their live name.
        if (
            REGISTRY.getStatus(resource) == IPermissionedRegistry.Status.REGISTERED
                && REGISTRY.getOwner(resource) == account
        ) revert MembershipStillLive(account);

        // The same teardown `revoke` runs. Skipping it here was the whole bug: namehash does
        // not include the registry's version id, so a stale grant on a freed label is a grant
        // on whoever is registered under that label next.
        _tearDown(resource, account);
        emit MembershipReleased(account, resource);
    }

    /// @notice Re-apply a role's current editable keys to one existing member.
    ///
    /// @dev Delegated rights live in the resolver from the moment of onboarding, so redefining a
    ///      role changes what *new* members get, not what existing ones hold. That is the cost of
    ///      letting the resolver be the enforcer rather than mediating every write here. This is
    ///      the deliberate catch-up: grant what the catalogue now lists, and name explicitly the
    ///      keys being withdrawn, since the contract no longer knows what it handed out before.
    function syncMemberKeys(uint256 anyId, string[] calldata withdraw) external {
        if (!hasRootRoles(ROLE_ROLE_EDIT, msg.sender)) revert NotARoleEditor(msg.sender);
        uint256 resource = _resolveResource(anyId);
        address member = memberOf[resource];
        if (member == address(0)) revert NotOnboarded(member);

        string memory label = labelOf[resource];
        bytes memory dnsName = membershipDnsName(label);
        for (uint256 i; i < withdraw.length; ++i) {
            RESOLVER.authorizeTextRoles(dnsName, withdraw[i], member, false);
        }
        delete _grantedKeys[resource];
        _delegateKeys(resource, label, _editableKeys[roleOf[resource]], member, true);
        emit MemberKeysSynced(resource, member);
    }

    /// @dev Everything that must happen when a membership ends, by any route: published
    ///      entitlements cleared, the member's own records cleared, every delegated key handed
    ///      back, and the bookkeeping dropped. Any path that ends a membership without this
    ///      leaves live write permissions pointing at a name somebody else will get.
    function _tearDown(uint256 resource, address member) internal {
        string memory label = labelOf[resource];
        bytes32 node = membershipNode(label);

        Entitlement[] storage grants = _entitlements[roleOf[resource]];
        for (uint256 i; i < grants.length; ++i) {
            RESOLVER.setText(node, grants[i].key, "");
        }

        string[] storage granted = _grantedKeys[resource];
        for (uint256 i; i < granted.length; ++i) {
            RESOLVER.setText(node, granted[i], "");
        }
        _delegateKeys(resource, label, granted, member, false);

        delete _grantedKeys[resource];
        delete roleOf[resource];
        delete memberOf[resource];
        delete labelOf[resource];
        delete membershipOf[member];
    }

    /// @dev Grant or revoke a set of keys to `account`, on their own name only.
    function _delegateKeys(
        uint256 resource,
        string memory label,
        string[] storage keys,
        address account,
        bool grant
    ) internal {
        if (keys.length == 0) return;
        // An empty label makes `namehash` return 0, which the resolver reads as "every name".
        // Unreachable today — every caller has a validated label — but the failure mode is a
        // member with write access to one key on every name this resolver serves.
        if (bytes(label).length == 0) revert InvalidLabel(label);

        bytes memory dnsName = membershipDnsName(label);
        for (uint256 i; i < keys.length; ++i) {
            RESOLVER.authorizeTextRoles(dnsName, keys[i], account, grant);
            if (grant) _grantedKeys[resource].push(keys[i]);
        }
    }

    /// @dev A membership id survives version bumps; `getResource` normalises whatever we are given.
    function _resolveResource(uint256 anyId) internal view returns (uint256) {
        if (memberOf[anyId] != address(0)) return anyId;
        return REGISTRY.getResource(anyId);
    }

    /// @dev `[a-z0-9-]`, 1-32 chars, no leading or trailing hyphen. The same restriction the
    ///      factory and the org registrar apply — a label they would reject must not enter here
    ///      through a side door, because a non-normalised label produces a node nothing resolves.
    function _isValidLabel(string calldata label) internal pure returns (bool) {
        bytes calldata b = bytes(label);
        if (b.length == 0 || b.length > 32) return false;
        if (b[0] == "-" || b[b.length - 1] == "-") return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) return false;
        }
        return true;
    }

    /// @notice The role that actually applies to `account` at this branch.
    /// @dev The resolution order from `docs/13` §5.4: a Membership here overrides everything;
    ///      otherwise the organization-wide role applies; otherwise nothing does.
    function effectiveRole(address account) public view returns (bytes32 role, bool fromOrg) {
        uint256 membership = membershipOf[account];
        // A closed branch confers no authority. `membershipOf` is only cleared by `revoke`, so
        // without this check an organizer whose branch expired keeps minting forever.
        if (membership != 0 && block.timestamp < BRANCH_EXPIRY) {
            return (roleOf[membership], false);
        }
        if (address(ORG) != address(0)) {
            bytes32 orgRole = ORG.orgRole(account);
            if (orgRole != bytes32(0) && roleSpec[orgRole].active) return (orgRole, true);
        }
        return (bytes32(0), false);
    }

    /// @notice Write a record on a membership. For staff, not members.
    ///
    /// @dev The node is derived from `resource`, never supplied. A caller-chosen node would let
    ///      any record editor write any key at any name this resolver serves — including a
    ///      sibling branch's members and the `ensca.registrar` discovery record.
    function setRecord(uint256 anyId, string calldata key, string calldata value) external {
        if (!hasRootRoles(ROLE_EDIT_RECORD, msg.sender)) revert CannotEditKey(msg.sender, key);
        uint256 resource = _resolveResource(anyId);
        if (memberOf[resource] == address(0)) revert NotOnboarded(memberOf[resource]);
        RESOLVER.setText(membershipNode(labelOf[resource]), key, value);
        emit RecordSet(resource, key, value);
    }

    ////////////////////////////////////////////////////////////////////////
    // The hook — where authority is derived rather than stored
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc EnhancedAccessControl
    /// @dev Adds the one role implied by the caller's own membership: minting. Nothing here
    ///      writes storage, so it never counts against EAC's 15-assignees-per-resource ceiling,
    ///      which is what lets an organization run unlimited volunteers.
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

        // Records are no longer derived here. A member's right to write their own keys lives in
        // the resolver, on `resource(membershipNode, partHash(key))`, granted at onboarding —
        // so the resolver enforces both the name and the key without this contract mediating.
    }
}
