// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {BranchFactory} from "./BranchFactory.sol";
import {IBranchRegistrarDeployer, IBranchRegistryDeployer} from "./BranchDeployers.sol";
import {
    IBranchFactoryDeployer,
    IOrgRegistrarDeployer,
    IOrgRegistryDeployer,
    IOrgResolverDeployer
} from "./OrgDeployers.sol";
import {OrgRegistrar} from "./OrgRegistrar.sol";

interface IEthRegistry {
    function setSubregistry(uint256 tokenId, address registry) external;
    function setResolver(uint256 tokenId, address resolver) external;
    function getResource(uint256 anyId) external view returns (uint256);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account)
        external
        view
        returns (bool);
}

interface IResolverAdmin {
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
}

/// @title OrgFactory
/// @notice Stands up a whole organization under a `.eth` name its caller already owns.
///
/// @dev Owning `acme.eth` is not the same as having an organization. An organization is four
///      contracts — a registry to hold branches, a resolver to publish records, an OrgRegistrar
///      to mint the Member layer, and a BranchFactory to open branches — all wired together and
///      all pinned to that one name. Until this existed, those were deploy scripts an operator
///      ran by hand, which meant the product had exactly one organization: whichever name the
///      scripts had been pointed at. Choosing a different name in the console changed a label on
///      screen and nothing else, and branches still landed under the original.
///
///      Three properties make the result actually the caller's:
///
///      1. **The node is derived from the name they give.** `namehash(dnsName)` is computed here
///         and checked against the label, so records cannot be written under a namespace the
///         caller does not control.
///      2. **Every contract is theirs.** Root of the registry, the resolver, the OrgRegistrar and
///         the BranchFactory all go to `msg.sender`. This factory keeps nothing.
///      3. **Each organization gets its own resolver.** Sharing one puts every organization in a
///         single 15-assignee EAC budget — the sixteenth branch anywhere reverts forever — and
///         lets one organization's registrar write records on another's names.
///
///      One thing this cannot do: point `acme.eth` at the new registry. That is
///      `setSubregistry` on the parent, which only the name's owner may call. So the caller does
///      it themselves afterwards, with `subregistryCall()` telling them exactly what to send.
contract OrgFactory {
    IPermissionedRegistry public immutable ETH_REGISTRY;
    ILabelStore public immutable LABEL_STORE;
    address public immutable RESOLVER_IMPLEMENTATION;

    IOrgRegistryDeployer public immutable REGISTRY_DEPLOYER;
    IOrgRegistrarDeployer public immutable REGISTRAR_DEPLOYER;
    IOrgResolverDeployer public immutable RESOLVER_DEPLOYER;
    IBranchFactoryDeployer public immutable FACTORY_DEPLOYER;
    IBranchRegistryDeployer public immutable BRANCH_REGISTRY_DEPLOYER;
    IBranchRegistrarDeployer public immutable BRANCH_REGISTRAR_DEPLOYER;

    struct Organization {
        address registry;
        address resolver;
        address orgRegistrar;
        address branchFactory;
        bytes32 node;
    }

    /// @notice What was deployed for a given `.eth` label. The console reads this to find an
    ///         organization it did not create in this session.
    mapping(bytes32 labelHash => Organization) public organizations;

    event OrganizationCreated(
        string label,
        bytes32 indexed node,
        address indexed owner,
        address registry,
        address resolver,
        address orgRegistrar,
        address branchFactory
    );

    error NotTheNameOwner(address caller, address owner);
    error NameNotRegistered(string label);
    error NameNodeMismatch();
    error AlreadySetUp(string label);
    error InvalidLabel(string label);

    constructor(
        IPermissionedRegistry ethRegistry,
        ILabelStore labelStore,
        address resolverImplementation,
        IOrgRegistryDeployer registryDeployer,
        IOrgRegistrarDeployer registrarDeployer,
        IOrgResolverDeployer resolverDeployer,
        IBranchFactoryDeployer factoryDeployer,
        IBranchRegistryDeployer branchRegistryDeployer,
        IBranchRegistrarDeployer branchRegistrarDeployer
    ) {
        ETH_REGISTRY = ethRegistry;
        LABEL_STORE = labelStore;
        RESOLVER_IMPLEMENTATION = resolverImplementation;
        REGISTRY_DEPLOYER = registryDeployer;
        REGISTRAR_DEPLOYER = registrarDeployer;
        RESOLVER_DEPLOYER = resolverDeployer;
        FACTORY_DEPLOYER = factoryDeployer;
        BRANCH_REGISTRY_DEPLOYER = branchRegistryDeployer;
        BRANCH_REGISTRAR_DEPLOYER = branchRegistrarDeployer;
    }

    /// @notice Has an organization already been stood up for this label?
    function organizationFor(string calldata label) external view returns (Organization memory) {
        return organizations[keccak256(bytes(label))];
    }

    /// @notice Stand up the organization for `<label>.eth`, which `msg.sender` must already own.
    /// @param label The `.eth` label, e.g. `acme` for `acme.eth`.
    /// @param dnsName DNS wire-format of the full name, e.g. `\x04acme\x03eth\x00`.
    function createOrganization(string calldata label, bytes calldata dnsName)
        external
        returns (Organization memory org)
    {
        if (!_validLabel(label)) revert InvalidLabel(label);

        bytes32 labelHash = keccak256(bytes(label));
        if (organizations[labelHash].registry != address(0)) revert AlreadySetUp(label);

        // The name must exist and be theirs. Anything else would let somebody stand up an
        // organization under a name they cannot point at it.
        uint256 anyId = uint256(labelHash);
        if (ETH_REGISTRY.getStatus(anyId) != IPermissionedRegistry.Status.REGISTERED) {
            revert NameNotRegistered(label);
        }
        {
            address owner = ETH_REGISTRY.getOwner(anyId);
            if (owner != msg.sender) revert NotTheNameOwner(msg.sender, owner);
        }

        // The node is derived from the name, and the name must be the one they named.
        bytes32 node = NameCoder.namehash(dnsName, 0);
        if (node != _expectedNode(label)) revert NameNodeMismatch();

        org.node = node;
        // Deployed with this factory as root so it can do the wiring below, then handed over in
        // full before the call returns. The same shape `BranchFactory` uses: hold briefly, give
        // away completely, keep nothing.
        org.registry = REGISTRY_DEPLOYER.deploy(LABEL_STORE, address(this));
        org.resolver = RESOLVER_DEPLOYER.deploy(RESOLVER_IMPLEMENTATION, address(this));

        // Memberships inherit the name's own expiry rather than an invented one, so nothing
        // below can outlive the name it hangs from.
        org.orgRegistrar = REGISTRAR_DEPLOYER.deploy(
            IPermissionedRegistry(org.registry),
            org.resolver,
            ETH_REGISTRY.getExpiry(anyId),
            address(this)
        );
        PermissionedRegistry(org.registry).grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW, org.orgRegistrar
        );

        org.branchFactory = FACTORY_DEPLOYER.deploy(
            IPermissionedRegistry(org.registry),
            OrgRegistrar(org.orgRegistrar),
            LABEL_STORE,
            org.resolver,
            node,
            dnsName,
            msg.sender,
            BRANCH_REGISTRY_DEPLOYER,
            BRANCH_REGISTRAR_DEPLOYER
        );

        // What the branch factory needs, granted on this organization's own contracts — so the
        // assignee budget is this organization's alone.
        BranchFactory factory = BranchFactory(org.branchFactory);
        PermissionedRegistry(org.registry).grantRootRoles(
            factory.requiredOrgRegistryRoles(), org.branchFactory
        );
        OrgRegistrar(org.orgRegistrar).grantRootRoles(
            factory.requiredOrgRegistrarRoles(), org.branchFactory
        );
        IResolverAdmin(org.resolver).grantRootRoles(
            factory.requiredResolverRoles(), org.branchFactory
        );

        // Point the name at what we just built, if the caller let us.
        //
        // They cannot do this themselves until the registry exists, so doing it here is the
        // difference between one wallet confirmation and three — and between a half-finished
        // organization and a working one when somebody closes the tab after the first. It only
        // happens when the owner has granted these two roles (batched alongside this call by
        // the console), and the grant is handed straight back below.
        _pointName(org, anyId);
        _handOver(org, msg.sender);

        organizations[labelHash] = org;
        emit OrganizationCreated(
            label, node, msg.sender, org.registry, org.resolver, org.orgRegistrar, org.branchFactory
        );
    }

    /// @dev Point `<label>.eth` at the organization, when the owner has delegated that.
    ///
    ///      Silent when they have not: the two-step flow still works, and a caller who does not
    ///      want to delegate anything should not be forced to.
    ///
    ///      This deliberately does **not** revoke the delegation itself. Doing so would need the
    ///      admin half of those roles, i.e. asking the owner for strictly more privilege than
    ///      the job requires. Instead the console puts the owner's own `revokeRoles` in the same
    ///      batched call, so the grant and its removal land in one atomic transaction and the
    ///      factory is never trusted with the power to re-grant itself anything.
    function _pointName(Organization memory org, uint256 anyId) internal {
        uint256 resource = ETH_REGISTRY.getResource(anyId);
        uint256 needed = RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER;
        if (!IEthRegistry(address(ETH_REGISTRY)).hasRoles(resource, needed, address(this))) return;

        IEthRegistry(address(ETH_REGISTRY)).setSubregistry(anyId, org.registry);
        IEthRegistry(address(ETH_REGISTRY)).setResolver(anyId, org.resolver);
    }

    /// @dev Give the caller everything and keep nothing. Separated out so `createOrganization`
    ///      stays inside the stack the optimiser can address.
    function _handOver(Organization memory org, address owner) internal {
        PermissionedRegistry(org.registry).grantRootRoles(EACBaseRolesLib.ALL_ROLES, owner);
        PermissionedRegistry(org.registry).revokeRootRoles(EACBaseRolesLib.ALL_ROLES, address(this));

        // Only what its constructor granted this factory. `ALL_ROLES` would ask it to hand over
        // admin bits for roles it never held, which EAC rightly refuses.
        OrgRegistrar registrar = OrgRegistrar(org.orgRegistrar);
        uint256 roles = registrar.ROLE_ENROL() | registrar.ROLE_ENROL_ADMIN()
            | registrar.ROLE_SET_ORG_ROLE() | registrar.ROLE_SET_ORG_ROLE_ADMIN();
        registrar.grantRootRoles(roles, owner);
        registrar.revokeRootRoles(roles, address(this));

        IResolverAdmin(org.resolver).grantRootRoles(EACBaseRolesLib.ALL_ROLES, owner);
        IResolverAdmin(org.resolver).revokeRootRoles(EACBaseRolesLib.ALL_ROLES, address(this));
    }

    /// @notice The `namehash` a `<label>.eth` should have.
    function _expectedNode(string calldata label) internal pure returns (bytes32) {
        bytes32 ethNode = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        return keccak256(abi.encodePacked(ethNode, keccak256(bytes(label))));
    }

    /// @dev `[a-z0-9-]`, 3-32 chars, no leading or trailing hyphen — matching what the rest of
    ///      the system accepts, so a name usable here is usable everywhere below it.
    function _validLabel(string calldata label) internal pure returns (bool) {
        bytes calldata b = bytes(label);
        if (b.length < 3 || b.length > 32) return false;
        if (b[0] == "-" || b[b.length - 1] == "-") return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) return false;
        }
        return true;
    }
}
