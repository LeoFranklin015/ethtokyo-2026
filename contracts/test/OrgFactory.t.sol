// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {OrgFactory} from "../src/OrgFactory.sol";
import {
    BranchFactoryDeployer,
    OrgRegistrarDeployer,
    OrgRegistryDeployer,
    OrgResolverDeployer
} from "../src/OrgDeployers.sol";
import {BranchRegistrarDeployer, BranchRegistryDeployer} from "../src/BranchDeployers.sol";
import {BranchFactory} from "../src/BranchFactory.sol";
import {BranchRegistrarV2} from "../src/BranchRegistrarV2.sol";
import {OrgRegistrar} from "../src/OrgRegistrar.sol";
import {MockPermissionedResolver} from "./MockPermissionedResolver.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {LabelStore} from "@ens-v2/utils/LabelStore.sol";
import {IContractNamer} from "@ens-v2/reverse-registrar/interfaces/IContractNamer.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

/// @dev Stands in for the deployed `PermissionedResolver` implementation an `ERC1967Proxy` is
///      pointed at. It only needs an `initialize` that does not revert, plus the record surface
///      the branch layer uses.
contract ResolverImplementation is MockPermissionedResolver {
    function initialize(address admin, uint256, bytes[] calldata) external {
        rootWriter[admin] = true;
    }
}

/// @notice Owning a name and having an organization are different things.
///
/// @dev Until `OrgFactory` existed, an organization was four contracts an operator deployed by
///      hand with forge scripts — so the product had exactly one, whichever name the scripts had
///      been aimed at. Choosing a different name in the console changed a string on screen and
///      nothing underneath: branches still landed under the original organization, because the
///      branch factory's `ORG_NODE` is immutable and was somebody else's.
contract OrgFactoryTest is Test {
    PermissionedRegistry internal ethRegistry;
    OrgFactory internal factory;
    ResolverImplementation internal resolverImpl;
    ILabelStore internal labelStore;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint64 internal expiry;

    /// @dev \x04acme\x03eth\x00
    bytes internal constant ACME_DNS = hex"0461636d650365746800";
    /// @dev \x05other\x03eth\x00
    bytes internal constant OTHER_DNS = hex"056f746865720365746800";

    function setUp() public {
        expiry = uint64(block.timestamp + 365 days);
        labelStore = ILabelStore(address(new LabelStore(IContractNamer(address(0)))));
        resolverImpl = new ResolverImplementation();

        ethRegistry = new PermissionedRegistry(labelStore, address(this), EACBaseRolesLib.ALL_ROLES);

        factory = new OrgFactory(
            IPermissionedRegistry(address(ethRegistry)),
            labelStore,
            address(resolverImpl),
            new OrgRegistryDeployer(),
            new OrgRegistrarDeployer(),
            new OrgResolverDeployer(),
            new BranchFactoryDeployer(),
            new BranchRegistryDeployer(),
            new BranchRegistrarDeployer()
        );
    }

    /// Register `<label>.eth` to `owner`, the way the ENS app would.
    function _own(string memory label, address owner) internal {
        ethRegistry.register(
            label, owner, IRegistry(address(0)), address(0), EACBaseRolesLib.ALL_ROLES, expiry
        );
    }

    function _create(string memory label, bytes memory dns, address who)
        internal
        returns (OrgFactory.Organization memory org)
    {
        vm.prank(who);
        return factory.createOrganization(label, dns);
    }

    ////////////////////////////////////////////////////////////////////////
    // The organization is real, and it is theirs
    ////////////////////////////////////////////////////////////////////////

    function test_stands_up_a_whole_organization() public {
        _own("acme", alice);
        OrgFactory.Organization memory org = _create("acme", ACME_DNS, alice);

        assertTrue(org.registry != address(0), "a registry to hold branches");
        assertTrue(org.resolver != address(0), "a resolver to publish records");
        assertTrue(org.orgRegistrar != address(0), "an OrgRegistrar for the Member layer");
        assertTrue(org.branchFactory != address(0), "a BranchFactory to open branches");
        assertEq(org.node, NameCoder.namehash(ACME_DNS, 0), "pinned to their own name");
    }

    function test_the_caller_owns_every_piece_of_it() public {
        _own("acme", alice);
        OrgFactory.Organization memory org = _create("acme", ACME_DNS, alice);

        assertTrue(
            PermissionedRegistry(org.registry).hasRootRoles(EACBaseRolesLib.ALL_ROLES, alice),
            "root of the registry"
        );
        assertTrue(
            OrgRegistrar(org.orgRegistrar).hasRootRoles(
                OrgRegistrar(org.orgRegistrar).ROLE_ENROL(), alice
            ),
            "may enrol Members"
        );
        assertTrue(
            BranchFactory(org.branchFactory).hasRootRoles(
                BranchFactory(org.branchFactory).ROLE_CREATE_BRANCH(), alice
            ),
            "may open branches"
        );
    }

    /// A factory that kept root of what it built could rewrite anybody's organization.
    function test_the_factory_keeps_nothing() public {
        _own("acme", alice);
        OrgFactory.Organization memory org = _create("acme", ACME_DNS, alice);

        assertFalse(
            PermissionedRegistry(org.registry).hasRootRoles(
                RegistryRolesLib.ROLE_REGISTRAR, address(factory)
            ),
            "cannot mint into the registry it made"
        );
        assertFalse(
            BranchFactory(org.branchFactory).hasRootRoles(
                BranchFactory(org.branchFactory).ROLE_CREATE_BRANCH(), address(factory)
            ),
            "cannot open branches in it either"
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // The point of the whole exercise
    ////////////////////////////////////////////////////////////////////////

    /// Branches must land under *their* name. This is the bug that prompted the contract: a
    /// shared factory put every branch under whichever organization it was deployed against.
    function test_branches_land_under_the_callers_own_name() public {
        _own("acme", alice);
        OrgFactory.Organization memory org = _create("acme", ACME_DNS, alice);

        vm.prank(alice);
        (address branchRegistry, address branchRegistrar) =
            BranchFactory(org.branchFactory).createBranch("tokyo", expiry, alice);

        bytes32 expected = keccak256(abi.encodePacked(org.node, keccak256("tokyo")));
        assertEq(
            BranchRegistrarV2(branchRegistrar).BRANCH_NODE(),
            expected,
            "tokyo.acme.eth, not tokyo.somebody-elses.eth"
        );
        assertEq(
            address(PermissionedRegistry(org.registry).getSubregistry("tokyo")),
            branchRegistry,
            "and the organization points at it"
        );
    }

    /// End to end: an organization created this way can actually admit somebody.
    function test_the_new_organization_can_onboard() public {
        _own("acme", alice);
        OrgFactory.Organization memory org = _create("acme", ACME_DNS, alice);

        vm.startPrank(alice);
        (, address registrar) = BranchFactory(org.branchFactory).createBranch("tokyo", expiry, alice);
        BranchRegistrarV2 r = BranchRegistrarV2(registrar);
        r.defineRole("hacker", 0, false, true, new string[](0), new BranchRegistrarV2.Entitlement[](0));
        r.onboard("leo", address(0xBEEF), r.roleId("hacker"), "leo");
        vm.stopPrank();

        assertTrue(
            OrgRegistrar(org.orgRegistrar).isMember(address(0xBEEF)),
            "and the Member name is minted on their own org registrar"
        );
    }

    /// Each organization gets its own resolver, so one cannot exhaust or read into another.
    function test_organizations_do_not_share_a_resolver() public {
        _own("acme", alice);
        _own("other", bob);
        OrgFactory.Organization memory a = _create("acme", ACME_DNS, alice);
        OrgFactory.Organization memory b = _create("other", OTHER_DNS, bob);

        assertTrue(a.resolver != b.resolver, "separate resolver instances");
        assertTrue(a.registry != b.registry, "separate registries");
        assertTrue(a.orgRegistrar != b.orgRegistrar, "separate Member layers");
    }

    ////////////////////////////////////////////////////////////////////////
    // Pointing the name, in the same transaction
    ////////////////////////////////////////////////////////////////////////

    /// Delegating two roles lets the factory finish the job, so the whole setup is one batched
    /// wallet confirmation rather than three sequential ones — and cannot be abandoned halfway.
    function test_points_the_name_when_the_owner_delegates_it() public {
        _own("acme", alice);

        uint256 resource = ethRegistry.getResource(uint256(keccak256("acme")));
        uint256 needed =
            RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER;
        vm.prank(alice);
        ethRegistry.grantRoles(resource, needed, address(factory));

        OrgFactory.Organization memory org = _create("acme", ACME_DNS, alice);

        assertEq(
            address(ethRegistry.getSubregistry("acme")),
            org.registry,
            "the name points at its own registry"
        );
        assertEq(ethRegistry.getResolver("acme"), org.resolver, "and its own resolver");
    }

    /// The delegation is the owner's to remove, and the console batches it into the same
    /// transaction — so the factory is never trusted to give itself anything back.
    function test_the_owner_takes_the_delegation_back_in_the_same_batch() public {
        _own("acme", alice);
        uint256 resource = ethRegistry.getResource(uint256(keccak256("acme")));
        uint256 needed =
            RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER;

        // What the console sends as one batched call: grant, create, revoke.
        vm.startPrank(alice);
        ethRegistry.grantRoles(resource, needed, address(factory));
        factory.createOrganization("acme", ACME_DNS);
        ethRegistry.revokeRoles(resource, needed, address(factory));
        vm.stopPrank();

        assertEq(
            address(ethRegistry.getSubregistry("acme")),
            factory.organizationFor("acme").registry,
            "the name is pointed"
        );
        assertFalse(
            ethRegistry.hasRoles(resource, needed, address(factory)),
            "and the factory keeps no say over it"
        );
    }

    /// Without the delegation it still works — the owner points the name themselves afterwards.
    function test_works_without_the_delegation_too() public {
        _own("acme", alice);
        OrgFactory.Organization memory org = _create("acme", ACME_DNS, alice);

        assertTrue(org.registry != address(0), "the organization is still built");
        assertEq(
            address(ethRegistry.getSubregistry("acme")),
            address(0),
            "just not pointed at yet"
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Guards
    ////////////////////////////////////////////////////////////////////////

    function test_only_the_name_owner_may_set_it_up() public {
        _own("acme", alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrgFactory.NotTheNameOwner.selector, bob, alice));
        factory.createOrganization("acme", ACME_DNS);
    }

    function test_refuses_a_name_nobody_has_registered() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrgFactory.NameNotRegistered.selector, "acme"));
        factory.createOrganization("acme", ACME_DNS);
    }

    /// The DNS name and the label must describe the same thing, or records land in a namespace
    /// the caller does not control.
    function test_refuses_a_name_that_is_not_its_own_node() public {
        _own("acme", alice);
        vm.prank(alice);
        vm.expectRevert(OrgFactory.NameNodeMismatch.selector);
        factory.createOrganization("acme", OTHER_DNS);
    }

    function test_refuses_to_set_the_same_name_up_twice() public {
        _own("acme", alice);
        _create("acme", ACME_DNS, alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrgFactory.AlreadySetUp.selector, "acme"));
        factory.createOrganization("acme", ACME_DNS);
    }

    function test_records_what_it_built_so_it_can_be_found_again() public {
        _own("acme", alice);
        OrgFactory.Organization memory org = _create("acme", ACME_DNS, alice);

        OrgFactory.Organization memory found = factory.organizationFor("acme");
        assertEq(found.branchFactory, org.branchFactory, "a console can find it without an event");
        assertEq(found.registry, org.registry);
    }
}
