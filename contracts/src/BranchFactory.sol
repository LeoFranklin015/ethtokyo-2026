// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EnhancedAccessControl} from "@ens-v2/access-control/EnhancedAccessControl.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {BranchRegistrarV2, IBranchResolver} from "./BranchRegistrarV2.sol";
import {IBranchRegistrarDeployer, IBranchRegistryDeployer} from "./BranchDeployers.sol";
import {OrgRegistrar} from "./OrgRegistrar.sol";

interface IResolverAdmin {
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
}

/// @title BranchFactory
/// @notice Opens a branch under an organization in a single transaction.
///
/// @dev Standing up a branch correctly takes nine steps across three contracts, and getting any of
///      them wrong leaves a branch that looks registered but does not work — a registry nothing
///      points at, a registrar with no authority, or records written to a node nothing resolves to.
///      Doing it atomically is the difference between a runbook and a product.
///
///      Three details matter for the result to be a *properly integrated* ENS name rather than a
///      contract that happens to own one:
///
///      1. **The namehash is derived here, never passed in.** `node = keccak256(orgNode, labelhash)`
///         is the only value records may be written at. Passing it as an argument invites the
///         label-versus-namehash mistake, where writes succeed and reads come back empty.
///      2. **The parent pointer is set both ways.** The org registry points down via the
///         subregistry, and the branch registry points back up via `setParent`, which is what lets
///         `UniversalHelper.findCanonicalName` walk the tree and name the branch.
///      3. **The branch publishes its own registrar.** A registrar is only an EAC role holder, so
///         it is invisible to any indexer. Writing `ensca.registrar` makes the whole topology
///         discoverable from ENS alone, with no address hardcoded anywhere off-chain.
///
///      The factory also keeps nothing. It is briefly root of the new registry so it can wire the
///      registrar up, then hands root to the branch owner and revokes itself in the same call.
contract BranchFactory is EnhancedAccessControl {
    using Strings for address;

    /// @notice Open a branch. Held by the organization, not by branch staff.
    uint256 public constant ROLE_CREATE_BRANCH = 1 << 0;
    uint256 public constant ROLE_CREATE_BRANCH_ADMIN = ROLE_CREATE_BRANCH << 128;

    /// @notice The record a branch publishes so its registrar can be found.
    string public constant REGISTRAR_KEY = "ensca.registrar";

    /// @dev Deployment is delegated so the factory does not carry the registry and registrar
    ///      bytecode in its own code — together they exceed EIP-170's 24,576-byte limit.
    IBranchRegistryDeployer public immutable REGISTRY_DEPLOYER;
    IBranchRegistrarDeployer public immutable REGISTRAR_DEPLOYER;

    IPermissionedRegistry public immutable ORG_REGISTRY;
    OrgRegistrar public immutable ORG_REGISTRAR;
    ILabelStore public immutable LABEL_STORE;
    address public immutable RESOLVER;

    /// @notice `namehash` of the organization, e.g. `namehash("acme.eth")`.
    bytes32 public immutable ORG_NODE;

    /// @notice DNS wire-format encoding of the organization, e.g. `\x04acme\x03eth\x00`.
    /// @dev The resolver's per-key authorization takes a name rather than a node, so a branch
    ///      needs its own encoding to delegate record rights. Derived here for the same reason
    ///      the namehash is: a supplied name is a supplied namehash.
    bytes public ORG_DNS_NAME;

    /// @dev Resolver role needed to publish the discovery record. Mirrors
    ///      `PermissionedResolverLib.ROLE_SET_TEXT`, which lives in a library this contract does
    ///      not otherwise depend on.
    uint256 private constant RESOLVER_ROLE_SET_TEXT = 1 << 4;
    uint256 private constant RESOLVER_ROLE_SET_TEXT_ADMIN = RESOLVER_ROLE_SET_TEXT << 128;

    /// @dev Every branch this organization has opened, so a console can list them from state
    ///      rather than scanning `BranchCreated` logs across an ever-growing block range.
    string[] internal _branchLabels;

    event BranchRetired(address indexed registrar);

    event BranchCreated(
        string label,
        bytes32 indexed node,
        address indexed registry,
        address indexed registrar,
        address owner
    );

    error NotABranchCreator(address account);
    error NotABranch(address registrar);
    error InvalidLabel(string label);
    error LabelUnavailable(string label);
    error InvalidExpiry(uint64 expiry);
    error InvalidOwner();

    constructor(
        IPermissionedRegistry orgRegistry,
        OrgRegistrar orgRegistrar,
        ILabelStore labelStore,
        address resolver,
        bytes32 orgNode,
        bytes memory orgDnsName,
        address admin,
        IBranchRegistryDeployer registryDeployer,
        IBranchRegistrarDeployer registrarDeployer
    ) {
        if (admin == address(0) || resolver == address(0)) revert InvalidOwner();
        REGISTRY_DEPLOYER = registryDeployer;
        REGISTRAR_DEPLOYER = registrarDeployer;
        ORG_REGISTRY = orgRegistry;
        ORG_REGISTRAR = orgRegistrar;
        LABEL_STORE = labelStore;
        RESOLVER = resolver;
        ORG_NODE = orgNode;
        ORG_DNS_NAME = orgDnsName;
        _grantRoles(ROOT_RESOURCE, ROLE_CREATE_BRANCH | ROLE_CREATE_BRANCH_ADMIN, admin, false);
    }

    /// @notice The ENS namehash a branch label will have. Derived, never supplied.
    function branchNode(string memory label) public view returns (bytes32) {
        return keccak256(abi.encodePacked(ORG_NODE, keccak256(bytes(label))));
    }

    /// @notice DNS wire-format name a branch label will have.
    function branchDnsName(string memory label) public view returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, ORG_DNS_NAME);
    }

    function isAvailable(string calldata label) external view returns (bool) {
        return _validLabel(label)
            && ORG_REGISTRY.getStatus(uint256(keccak256(bytes(label))))
                == IPermissionedRegistry.Status.AVAILABLE;
    }

    /// @notice Every branch label this factory has opened.
    function allBranchLabels() external view returns (string[] memory) {
        return _branchLabels;
    }

    function branchCount() external view returns (uint256) {
        return _branchLabels.length;
    }

    /// @notice What the organization must grant this factory before it can open branches.
    /// @dev Returned rather than documented so a deployment script cannot drift from the contract.
    function requiredOrgRegistryRoles() public pure returns (uint256) {
        return RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW;
    }

    function requiredOrgRegistrarRoles() public view returns (uint256) {
        // The admin role, because the factory grants enrolment onward to each new registrar
        // rather than using it itself.
        return ORG_REGISTRAR.ROLE_ENROL_ADMIN();
    }

    function requiredResolverRoles() public pure returns (uint256) {
        return RESOLVER_ROLE_SET_TEXT | (RESOLVER_ROLE_SET_TEXT << 128);
    }

    /// @notice Open a branch: registry, registrar, pointers, authority and discovery record.
    /// @param label The branch label, becoming `<label>.<organization>`.
    /// @param expiry Absolute unix timestamp the branch closes at.
    /// @param owner Receives root of the branch registry and every registrar permission.
    function createBranch(string calldata label, uint64 expiry, address owner)
        external
        returns (address registry, address registrar)
    {
        if (!hasRootRoles(ROLE_CREATE_BRANCH, msg.sender)) revert NotABranchCreator(msg.sender);
        if (owner == address(0)) revert InvalidOwner();
        if (expiry <= block.timestamp) revert InvalidExpiry(expiry);
        if (!_validLabel(label)) revert InvalidLabel(label);
        if (
            ORG_REGISTRY.getStatus(uint256(keccak256(bytes(label))))
                != IPermissionedRegistry.Status.AVAILABLE
        ) revert LabelUnavailable(label);

        // The factory takes root of the new registry only so it can wire everything up; it gives
        // that away before the call returns.
        registry = REGISTRY_DEPLOYER.deploy(LABEL_STORE, address(this));

        // Forward pointer: the org name resolves to this registry.
        ORG_REGISTRY.register(label, owner, IRegistry(registry), RESOLVER, 0, expiry);
        // Backward pointer: the registry knows where it sits, so the tree can be walked upward.
        PermissionedRegistry(registry).setParent(ORG_REGISTRY, label);

        registrar = REGISTRAR_DEPLOYER.deploy(
            IPermissionedRegistry(registry),
            IBranchResolver(RESOLVER),
            expiry,
            owner,
            ORG_REGISTRAR,
            branchNode(label),
            branchDnsName(label)
        );

        // Authority, in the three places a branch registrar needs it.
        PermissionedRegistry(registry).grantRootRoles(
            BranchRegistrarV2(registrar).REQUIRED_REGISTRY_ROLES(), registrar
        );
        ORG_REGISTRAR.grantRootRoles(ORG_REGISTRAR.ROLE_ENROL(), registrar);
        // Both halves: SET_TEXT to write entitlements, SET_TEXT_ADMIN to hand members their own
        // per-key rights through `authorizeTextRoles`.
        IResolverAdmin(RESOLVER).grantRootRoles(
            RESOLVER_ROLE_SET_TEXT | RESOLVER_ROLE_SET_TEXT_ADMIN, registrar
        );

        // Publish the registrar so the branch is discoverable from ENS with nothing hardcoded.
        IResolverAdmin(RESOLVER).setText(branchNode(label), REGISTRAR_KEY, registrar.toHexString());

        // Hand the branch over, then keep nothing.
        PermissionedRegistry(registry).grantRootRoles(EACBaseRolesLib.ALL_ROLES, owner);
        PermissionedRegistry(registry).revokeRootRoles(EACBaseRolesLib.ALL_ROLES, address(this));

        _branchLabels.push(label);
        emit BranchCreated(label, branchNode(label), registry, registrar, owner);
    }

    /// @notice Hand back the shared-contract grants a branch holds, when it closes.
    ///
    /// @dev This is not housekeeping, it is a hard requirement. EAC counts assignees per role
    ///      per resource in a **4-bit nybble** and reverts `EACMaxAssignees` at 15. Every branch
    ///      takes one slot of `ROLE_SET_TEXT` on the shared resolver and one of `ROLE_ENROL` on
    ///      the shared OrgRegistrar, at `ROOT_RESOURCE` — so without this, the **16th branch an
    ///      organization ever opens reverts, permanently**. That is not a theoretical limit: it
    ///      was hit in testing, and the only remedy was revoking by hand.
    ///
    ///      The real fix is one resolver per branch, which is also what ENS recommends — the
    ///      resolver instance is the trust boundary. Until then, retiring a branch frees its slot.
    function retireBranch(address registrar) external {
        if (!hasRootRoles(ROLE_CREATE_BRANCH, msg.sender)) revert NotABranchCreator(msg.sender);
        // Only something that looks like one of ours; a bad address here would revoke a grant
        // belonging to a contract we did not create.
        if (BranchRegistrarV2(registrar).BRANCH_NODE() == bytes32(0)) revert NotABranch(registrar);

        ORG_REGISTRAR.revokeRootRoles(ORG_REGISTRAR.ROLE_ENROL(), registrar);
        IResolverAdmin(RESOLVER).revokeRootRoles(
            RESOLVER_ROLE_SET_TEXT | RESOLVER_ROLE_SET_TEXT_ADMIN, registrar
        );
        emit BranchRetired(registrar);
    }

    /// @dev `[a-z0-9-]`, 1-32 chars, no leading or trailing hyphen — the same restriction the
    ///      registrars apply, which sidesteps ENSIP-15 normalisation rather than attempting it
    ///      on-chain.
    function _validLabel(string calldata label) internal pure returns (bool) {
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
