// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EnhancedAccessControl} from "@ens-v2/access-control/EnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";

/// @title BranchRegistrar
/// @notice Onboards memberships into one branch registry.
///
/// @dev A branch is an ENSv2 registry of its own; a membership is a name inside it. Enhanced Access
///      Control governs names, but it cannot express "this account may onboard, yet only at the
///      hacker role" — `ROLE_REGISTRAR` is binary, so any holder could mint themselves an organizer.
///      ENSv2 puts business logic in the registrar for exactly this reason.
///
///      So: no human holds `ROLE_REGISTRAR` on the branch registry. This contract does. Humans hold
///      `ROLE_ONBOARD` here, and this contract decides what they are allowed to mint.
contract BranchRegistrar is EnhancedAccessControl {
    ////////////////////////////////////////////////////////////////////////
    // Roles — EAC nybble layout, admin counterpart at `role << 128`
    ////////////////////////////////////////////////////////////////////////

    /// @dev Nybble 0: create memberships. On its own, hacker role only.
    uint256 public constant ROLE_ONBOARD = 1 << 0;
    uint256 public constant ROLE_ONBOARD_ADMIN = ROLE_ONBOARD << 128;

    /// @dev Nybble 1: onboard or promote at any role.
    uint256 public constant ROLE_PROMOTE = 1 << 4;
    uint256 public constant ROLE_PROMOTE_ADMIN = ROLE_PROMOTE << 128;

    /// @dev Nybble 2: end a membership.
    uint256 public constant ROLE_REVOKE = 1 << 8;
    uint256 public constant ROLE_REVOKE_ADMIN = ROLE_REVOKE << 128;

    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @dev `None` is ordinal 0 so an unset mapping reads as "no role", not as Hacker.
    enum Role {
        None,
        Hacker,
        Volunteer,
        Mentor,
        Partner,
        Organizer
    }

    /// @notice Roles this contract must hold at the branch registry's `ROOT_RESOURCE`.
    /// @dev `ROLE_REGISTRAR` to mint, `ROLE_RENEW` to extend, `ROLE_UNREGISTER` to revoke, and the
    ///      two `_ADMIN` roles so `promote` can rewrite a membership's bitmap after registration:
    ///      `PermissionedRegistry._getSettableRoles` only lets an account grant a role on an
    ///      existing name if it holds that role's admin counterpart.
    uint256 public constant REQUIRED_REGISTRY_ROLES = RegistryRolesLib.ROLE_REGISTRAR
        | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER
        | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN;

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The branch's own registry. Memberships are names inside it.
    IPermissionedRegistry public immutable REGISTRY;

    /// @notice Resolver every membership is pointed at on registration.
    address public immutable RESOLVER;

    /// @notice The branch window. Memberships expire with the branch, never after it.
    uint64 public immutable BRANCH_EXPIRY;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @notice Membership role by canonical resource id.
    /// @dev Keyed on the registry's resource, never the token id: ENSv2 token ids are regenerated
    ///      when roles change, so a promotion would otherwise read as a different name.
    mapping(uint256 resource => Role) public roleOf;

    /// @notice One membership per wallet per branch.
    mapping(address account => uint256 resource) public membershipOf;

    /// @notice The wallet a membership was minted for.
    /// @dev Recorded here rather than read back from the registry: `getOwner` returns the zero
    ///      address once a name expires, which would otherwise strand every membership as
    ///      un-promotable and un-revokable the moment the branch window closes.
    mapping(uint256 resource => address member) public memberOf;

    /// @dev Reentrancy latch. `REGISTRY.register` mints an ERC1155 to `owner`, which calls
    ///      `onERC1155Received` on it before this contract has written its bookkeeping.
    uint256 private _entered;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    event Onboarded(uint256 indexed resource, string label, address indexed owner, Role role);
    event Promoted(uint256 indexed resource, Role oldRole, Role newRole);
    event Revoked(uint256 indexed resource, address indexed owner);
    event Renewed(uint256 indexed resource, uint64 newExpiry);
    event Released(uint256 indexed resource, address indexed account);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    error Reentrancy();
    error InvalidRole();
    error NotAnOnboarder(address account);
    error CannotGrantRole(address account, Role role);
    error NotARevoker(address account);
    error NotARenewer(address account);
    error LabelUnavailable(string label);
    error InvalidLabel(string label);
    error AlreadyOnboarded(address account, uint256 resource);
    error NotOnboarded(uint256 resource);
    error InvalidOwner();
    error InvalidExpiry(uint64 branchExpiry);

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    ////////////////////////////////////////////////////////////////////////
    // Construction
    ////////////////////////////////////////////////////////////////////////

    /// @param registry The branch registry this registrar mints into.
    /// @param resolver Resolver assigned to every membership.
    /// @param branchExpiry Absolute unix timestamp the branch closes at.
    /// @param admin Receives every role plus its admin counterpart, contract-wide.
    constructor(IPermissionedRegistry registry, address resolver, uint64 branchExpiry, address admin) {
        if (admin == address(0) || address(registry) == address(0) || resolver == address(0)) {
            revert InvalidOwner();
        }
        if (branchExpiry <= block.timestamp) revert InvalidExpiry(branchExpiry);
        REGISTRY = registry;
        RESOLVER = resolver;
        BRANCH_EXPIRY = branchExpiry;

        _grantRoles(
            ROOT_RESOURCE,
            ROLE_ONBOARD | ROLE_ONBOARD_ADMIN | ROLE_PROMOTE | ROLE_PROMOTE_ADMIN | ROLE_REVOKE
                | ROLE_REVOKE_ADMIN,
            admin,
            false
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Lifecycle
    ////////////////////////////////////////////////////////////////////////

    /// @notice Create a membership at this branch.
    /// @dev `ROLE_ONBOARD` alone mints hackers. Anything above that additionally needs
    ///      `ROLE_PROMOTE`, which is what keeps a volunteer from minting themselves an organizer.
    function onboard(string calldata label, address owner, Role role)
        external
        nonReentrant
        returns (uint256 resource)
    {
        if (role == Role.None) revert InvalidRole();
        if (!hasRootRoles(ROLE_ONBOARD, msg.sender)) revert NotAnOnboarder(msg.sender);
        if (role != Role.Hacker && !hasRootRoles(ROLE_PROMOTE, msg.sender)) {
            revert CannotGrantRole(msg.sender, role);
        }
        if (owner == address(0)) revert InvalidOwner();
        if (!_isValidLabel(label)) revert InvalidLabel(label);

        uint256 labelHash = uint256(keccak256(bytes(label)));
        if (REGISTRY.getStatus(labelHash) != IPermissionedRegistry.Status.AVAILABLE) {
            revert LabelUnavailable(label);
        }

        uint256 existing = membershipOf[owner];
        if (existing != 0) revert AlreadyOnboarded(owner, existing);

        uint256 tokenId = REGISTRY.register(
            label,
            owner,
            IRegistry(address(0)), // memberships have no subregistry of their own
            RESOLVER,
            registryBitmapFor(role),
            BRANCH_EXPIRY
        );

        resource = REGISTRY.getResource(tokenId);
        roleOf[resource] = role;
        memberOf[resource] = owner;
        membershipOf[owner] = resource;

        emit Onboarded(resource, label, owner, role);
    }

    /// @notice Change a membership's role.
    /// @dev Registry roles are rewritten to match. This is reversible, unlike ENSv1 fuses.
    function promote(uint256 anyId, Role newRole) external nonReentrant {
        if (newRole == Role.None) revert InvalidRole();
        if (!hasRootRoles(ROLE_PROMOTE, msg.sender)) revert CannotGrantRole(msg.sender, newRole);

        uint256 resource = _resolveResource(anyId);
        Role oldRole = _requireOnboarded(resource);
        if (oldRole == newRole) return;

        address owner = memberOf[resource];
        uint256 oldBitmap = registryBitmapFor(oldRole);
        uint256 newBitmap = registryBitmapFor(newRole);

        // Revoke first, then grant, so overlapping roles are not dropped.
        uint256 toRevoke = oldBitmap & ~newBitmap;
        uint256 toGrant = newBitmap & ~oldBitmap;
        if (toRevoke != 0) REGISTRY.revokeRoles(resource, toRevoke, owner);
        if (toGrant != 0) REGISTRY.grantRoles(resource, toGrant, owner);

        roleOf[resource] = newRole;
        emit Promoted(resource, oldRole, newRole);
    }

    /// @notice End a membership. Enforcers deny on their next check.
    function revoke(uint256 anyId) external nonReentrant {
        if (!hasRootRoles(ROLE_REVOKE, msg.sender)) revert NotARevoker(msg.sender);

        uint256 resource = _resolveResource(anyId);
        _requireOnboarded(resource);

        address owner = memberOf[resource];

        // An expired membership is already gone from ENS and the registry rejects unregistering
        // it (`LabelExpired`). Revoking one is then pure bookkeeping cleanup.
        if (REGISTRY.getStatus(resource) != IPermissionedRegistry.Status.AVAILABLE) {
            REGISTRY.unregister(resource);
        }

        delete roleOf[resource];
        delete memberOf[resource];
        delete membershipOf[owner];

        emit Revoked(resource, owner);
    }

    /// @notice Extend a membership past the branch window.
    /// @dev The registrar already holds `ROLE_RENEW`; without this entrypoint that privilege sits
    ///      granted and unusable, and every membership dies with `BRANCH_EXPIRY`.
    function renew(uint256 anyId, uint64 newExpiry) external {
        if (!hasRootRoles(ROLE_PROMOTE, msg.sender)) revert NotARenewer(msg.sender);
        uint256 resource = _resolveResource(anyId);
        _requireOnboarded(resource);
        REGISTRY.renew(resource, newExpiry);
        emit Renewed(resource, newExpiry);
    }

    /// @notice Drop this contract's record of a membership without touching the registry.
    /// @dev An escape hatch, not part of the normal lifecycle. A membership can desync from the
    ///      registry — someone with root `ROLE_UNREGISTER` deletes the name directly, or the label
    ///      is re-registered and its `eacVersionId` bumps, giving it a new resource. The stale
    ///      entry would otherwise pin `membershipOf[account]` forever and lock that wallet out of
    ///      ever being onboarded again.
    function releaseMembership(address account) external {
        if (!hasRootRoles(ROLE_REVOKE, msg.sender)) revert NotARevoker(msg.sender);
        uint256 resource = membershipOf[account];
        if (resource == 0) revert NotOnboarded(0);
        delete roleOf[resource];
        delete memberOf[resource];
        delete membershipOf[account];
        emit Released(resource, account);
    }

    ////////////////////////////////////////////////////////////////////////
    // Views
    ////////////////////////////////////////////////////////////////////////

    /// @notice Registry role bitmap granted to a membership holder over their own name.
    ///
    /// @dev Two deliberate exclusions:
    ///
    ///      * `ROLE_CAN_TRANSFER_ADMIN` is withheld from every role, which makes memberships
    ///        soulbound. A membership is a statement about a person, not an asset.
    ///      * No admin (`_ADMIN`) roles are granted to members. ENSv2 refuses to grant admin roles
    ///        on an already-registered name — `_getSettableRoles` returns only regular roles for a
    ///        non-root resource — so a promotion could never add them anyway. It is also the right
    ///        model: a partner may set their own resolver, but delegating that right to a third
    ///        party is the organization's call, not theirs.
    function registryBitmapFor(Role role) public pure returns (uint256) {
        if (role == Role.Partner) {
            return RegistryRolesLib.ROLE_SET_RESOLVER;
        }
        if (role == Role.Organizer) {
            return RegistryRolesLib.ROLE_SET_RESOLVER | RegistryRolesLib.ROLE_SET_SUBREGISTRY;
        }
        // Hacker, Volunteer, Mentor: no registry roles at all. The holder owns the name and can
        // prove it by signature, but `setText` from their wallet reverts. Record rights, where a
        // role has any, come from the resolver.
        return 0;
    }

    function isAvailable(string calldata label) external view returns (bool) {
        return REGISTRY.getStatus(uint256(keccak256(bytes(label))))
            == IPermissionedRegistry.Status.AVAILABLE;
    }

    /// @notice Role held at this branch by `account`, and whether they hold one at all.
    function membership(address account) external view returns (bool exists, uint256 resource, Role role) {
        resource = membershipOf[account];
        exists = resource != 0;
        role = roleOf[resource];
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal
    ////////////////////////////////////////////////////////////////////////

    /// @dev Map any identifier onto the resource this contract recorded at onboarding.
    ///      `PermissionedRegistry._constructResource` returns `eacVersionId + 1` once a name has
    ///      expired, so re-deriving through the registry after the branch window yields an id that
    ///      never matches our bookkeeping. Fall back to treating `anyId` as the resource itself,
    ///      which is what `Onboarded` emits and what clients index on.
    function _resolveResource(uint256 anyId) internal view returns (uint256) {
        uint256 resource = REGISTRY.getResource(anyId);
        if (memberOf[resource] == address(0) && memberOf[anyId] != address(0)) return anyId;
        return resource;
    }

    function _requireOnboarded(uint256 resource) internal view returns (Role role) {
        address member = memberOf[resource];
        if (member == address(0) || membershipOf[member] != resource) revert NotOnboarded(resource);
        return roleOf[resource];
    }

    /// @dev Labels are restricted to `[a-z0-9-]`, 1-32 chars, not starting or ending with `-`.
    ///      This sidesteps ENSIP-15 normalisation edge cases entirely rather than trying to
    ///      implement normalisation on-chain.
    function _isValidLabel(string calldata label) internal pure returns (bool) {
        bytes calldata b = bytes(label);
        if (b.length == 0 || b.length > 32) return false;
        if (b[0] == "-" || b[b.length - 1] == "-") return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
            if (!ok) return false;
        }
        return true;
    }
}
