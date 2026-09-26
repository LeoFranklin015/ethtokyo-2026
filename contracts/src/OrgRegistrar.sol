// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EnhancedAccessControl} from "@ens-v2/access-control/EnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";

/// @title OrgRegistrar
/// @notice Mints and holds the Member layer — a person's one name at the organization.
///
/// @dev `docs/13-ens-design.md` §1: *"Member | name in org registry, no subregistry"*, minted
///      *"once ever"* at a person's first onboarding anywhere in the organization. A Membership
///      (`leo.tokyo.acme.eth`) is their standing at one branch and ends with it; the Member name
///      (`leo.acme.eth`) is the identity that survives and carries across branches.
///
///      Branch registrars call `ensureMember` during onboarding, so the first branch someone is
///      onboarded to creates their Member name and every later branch reuses it.
contract OrgRegistrar is EnhancedAccessControl {
    /// @dev Create Member names. Held by branch registrars, not by people.
    uint256 public constant ROLE_ENROL = 1 << 0;
    uint256 public constant ROLE_ENROL_ADMIN = ROLE_ENROL << 128;

    /// @dev Set a Member's organization-wide role — the fallback when no Membership overrides it.
    uint256 public constant ROLE_SET_ORG_ROLE = 1 << 4;
    uint256 public constant ROLE_SET_ORG_ROLE_ADMIN = ROLE_SET_ORG_ROLE << 128;

    IPermissionedRegistry public immutable REGISTRY;
    address public immutable RESOLVER;
    uint64 public immutable EXPIRY;

    mapping(address account => uint256 resource) public memberOf;
    mapping(address account => string label) public labelOf;
    /// @notice Organization-scoped role, honoured at every branch unless a Membership overrides it.
    mapping(address account => bytes32 roleId) public orgRole;

    event MemberEnrolled(uint256 indexed resource, string label, address indexed account);
    event OrgRoleSet(address indexed account, bytes32 indexed roleId);

    error NotAnEnroller(address account);
    error NotAnOrgRoleSetter(address account);
    error LabelUnavailable(string label);
    error InvalidLabel(string label);
    error InvalidOwner();

    constructor(IPermissionedRegistry registry, address resolver, uint64 expiry, address admin) {
        if (admin == address(0) || address(registry) == address(0)) revert InvalidOwner();
        REGISTRY = registry;
        RESOLVER = resolver;
        EXPIRY = expiry;
        _grantRoles(
            ROOT_RESOURCE,
            ROLE_ENROL | ROLE_ENROL_ADMIN | ROLE_SET_ORG_ROLE | ROLE_SET_ORG_ROLE_ADMIN,
            admin,
            false
        );
    }

    /// @notice Return this wallet's Member resource, creating the name if this is their first time.
    /// @dev Idempotent: a second branch onboarding the same wallet reuses the existing name.
    function ensureMember(string calldata label, address account) external returns (uint256 resource) {
        if (!hasRootRoles(ROLE_ENROL, msg.sender)) revert NotAnEnroller(msg.sender);
        if (account == address(0)) revert InvalidOwner();

        resource = memberOf[account];
        if (resource != 0) return resource; // already a Member — nothing to mint

        if (!_isValidLabel(label)) revert InvalidLabel(label);
        if (REGISTRY.getStatus(uint256(keccak256(bytes(label)))) != IPermissionedRegistry.Status.AVAILABLE) {
            revert LabelUnavailable(label);
        }

        // Claim the slot before minting. `register` mints an ERC1155, which calls back into
        // `account`; a contract re-entering through another branch's registrar would otherwise
        // still see `memberOf[account] == 0` and mint a second Member name for the same wallet,
        // breaking the one-name-ever invariant this contract exists to hold.
        memberOf[account] = type(uint256).max;

        // The Member name carries no registry roles and no subregistry: it is an identity anchor,
        // not a namespace. Branches are the names that get subregistries.
        uint256 tokenId =
            REGISTRY.register(label, account, IRegistry(address(0)), RESOLVER, 0, EXPIRY);
        resource = REGISTRY.getResource(tokenId);

        memberOf[account] = resource;
        labelOf[account] = label;
        emit MemberEnrolled(resource, label, account);
    }

    /// @notice Grant an organization-wide role, honoured at every branch.
    /// @dev This is the second step of the resolution order in `docs/13` §5.4:
    ///      Membership at this branch → else org-scoped role → else deny.
    function setOrgRole(address account, bytes32 roleId) external {
        if (!hasRootRoles(ROLE_SET_ORG_ROLE, msg.sender)) revert NotAnOrgRoleSetter(msg.sender);
        orgRole[account] = roleId;
        emit OrgRoleSet(account, roleId);
    }

    function isMember(address account) external view returns (bool) {
        return memberOf[account] != 0;
    }

    /// @dev `[a-z0-9-]`, 1-32 chars, no leading or trailing hyphen. Sidesteps ENSIP-15
    ///      normalisation rather than attempting it on-chain.
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
}
