// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BranchFactory} from "../src/BranchFactory.sol";
import {BranchRegistrarDeployer, BranchRegistryDeployer} from "../src/BranchDeployers.sol";
import {BranchRegistrarV2, IBranchResolver} from "../src/BranchRegistrarV2.sol";
import {OrgRegistrar} from "../src/OrgRegistrar.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {MockPermissionedResolver} from "./MockPermissionedResolver.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {LabelStore} from "@ens-v2/utils/LabelStore.sol";
import {IContractNamer} from "@ens-v2/reverse-registrar/interfaces/IContractNamer.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";

contract BranchFactoryTest is Test {
    PermissionedRegistry internal orgRegistry;
    OrgRegistrar internal orgRegistrar;
    MockPermissionedResolver internal resolver;
    BranchFactory internal factory;

    address internal org = address(0xA001);
    address internal branchOwner = address(0xA002);
    address internal outsider = address(0xA003);

    /// @dev \x04acme\x03eth\x00 — what the resolver re-hashes when authorizing a key.
    bytes internal constant ORG_DNS_NAME = hex"0461636d650365746800";
    bytes32 internal ORG_NODE = NameCoder.namehash(ORG_DNS_NAME, 0);
    uint64 internal expiry;

    uint256 internal CREATE;

    function setUp() public {
        expiry = uint64(block.timestamp + 90 days);
        resolver = new MockPermissionedResolver();

        orgRegistry = new PermissionedRegistry(
            ILabelStore(address(new LabelStore(IContractNamer(address(0))))),
            address(this),
            EACBaseRolesLib.ALL_ROLES
        );
        orgRegistrar = new OrgRegistrar(
            IPermissionedRegistry(address(orgRegistry)), address(resolver), expiry, org
        );
        orgRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW, address(orgRegistrar)
        );

        factory = new BranchFactory(
            IPermissionedRegistry(address(orgRegistry)),
            orgRegistrar,
            ILabelStore(address(new LabelStore(IContractNamer(address(0))))),
            address(resolver),
            ORG_NODE,
            ORG_DNS_NAME,
            org,
            new BranchRegistryDeployer(),
            new BranchRegistrarDeployer()
        );

        // The one-time grants the organization makes to the factory. Read from the contract so a
        // drift between what it needs and what setup gives it fails here, not in production.
        orgRegistry.grantRootRoles(factory.requiredOrgRegistryRoles(), address(factory));
        // The factory publishes the discovery record and delegates the registrar's resolver
        // rights, so it needs SET_TEXT and its admin half — exactly what it advertises.
        resolver.grantRootRoles(factory.requiredResolverRoles(), address(factory));
        uint256 enrolAdmin = factory.requiredOrgRegistrarRoles();
        vm.prank(org);
        orgRegistrar.grantRootRoles(enrolAdmin, address(factory));

        CREATE = factory.ROLE_CREATE_BRANCH();
    }

    function _create(string memory label) internal returns (address registry, address registrar) {
        vm.prank(org);
        return factory.createBranch(label, expiry, branchOwner);
    }

    ////////////////////////////////////////////////////////////////////////
    // The branch is wired up correctly
    ////////////////////////////////////////////////////////////////////////

    function test_creates_a_working_branch_in_one_call() public {
        (address registry, address registrar) = _create("tokyo");

        assertTrue(registry != address(0) && registrar != address(0));
        assertEq(
            address(orgRegistry.getSubregistry("tokyo")), registry, "org points down at the branch"
        );

        (IRegistry parent, string memory label) = PermissionedRegistry(registry).getParent();
        assertEq(address(parent), address(orgRegistry), "branch points back up");
        assertEq(label, "tokyo", "and knows what it is called there");
    }

    /// The namehash is derived, never supplied — the class of bug that writes records nowhere.
    function test_derives_the_namehash_itself() public {
        (, address registrar) = _create("tokyo");

        bytes32 expected = keccak256(abi.encodePacked(ORG_NODE, keccak256("tokyo")));
        assertEq(factory.branchNode("tokyo"), expected);
        assertEq(BranchRegistrarV2(registrar).BRANCH_NODE(), expected, "registrar agrees");
    }

    /// A registrar is invisible to indexers, so the branch publishes it.
    function test_publishes_its_registrar_for_discovery() public {
        (, address registrar) = _create("tokyo");

        string memory published = resolver.text(factory.branchNode("tokyo"), "ensca.registrar");
        assertEq(
            keccak256(bytes(published)),
            keccak256(bytes(vm.toLowercase(vm.toString(registrar)))),
            "ensca.registrar names the registrar"
        );
    }

    function test_registrar_has_authority_everywhere_it_needs_it() public {
        (address registry, address registrar) = _create("tokyo");

        assertTrue(
            PermissionedRegistry(registry).hasRootRoles(
                BranchRegistrarV2(registrar).REQUIRED_REGISTRY_ROLES(), registrar
            ),
            "may mint into the branch registry"
        );
        assertTrue(
            orgRegistrar.hasRootRoles(orgRegistrar.ROLE_ENROL(), registrar),
            "may enrol Members at the organization"
        );
        assertTrue(
            resolver.rootWriter(registrar), "may write entitlement records"
        );
    }

    /// End to end: the branch this produced can actually onboard somebody.
    function test_the_new_branch_can_onboard() public {
        (address registry, address registrar) = _create("tokyo");
        BranchRegistrarV2 r = BranchRegistrarV2(registrar);

        vm.startPrank(branchOwner);
        r.defineRole(
            "hacker", 0, false, true, new string[](0), new BranchRegistrarV2.Entitlement[](0)
        );
        uint256 resource = r.onboard("leo", address(0xB001), r.roleId("hacker"), "leo");
        vm.stopPrank();

        assertEq(PermissionedRegistry(registry).getOwner(resource), address(0xB001));
        assertTrue(orgRegistrar.isMember(address(0xB001)), "Member name minted too");
    }

    ////////////////////////////////////////////////////////////////////////
    // The factory keeps nothing
    ////////////////////////////////////////////////////////////////////////

    /// The property that matters most: a factory that retained root could rewrite any branch.
    function test_factory_retains_no_power_over_the_branch() public {
        (address registry,) = _create("tokyo");

        assertFalse(
            PermissionedRegistry(registry).hasRootRoles(
                EACBaseRolesLib.ALL_ROLES, address(factory)
            ),
            "factory is not root of the branch it made"
        );
        assertFalse(
            PermissionedRegistry(registry).hasRootRoles(
                RegistryRolesLib.ROLE_UNREGISTER, address(factory)
            ),
            "and cannot delete names in it"
        );
        assertTrue(
            PermissionedRegistry(registry).hasRootRoles(EACBaseRolesLib.ALL_ROLES, branchOwner),
            "the branch owner is root instead"
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Authority and validation
    ////////////////////////////////////////////////////////////////////////

    function test_only_a_branch_creator_may_open_one() public {
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(BranchFactory.NotABranchCreator.selector, outsider)
        );
        factory.createBranch("tokyo", expiry, branchOwner);
    }

    function test_organization_can_delegate_branch_creation() public {
        vm.prank(org);
        factory.grantRootRoles(CREATE, outsider);

        vm.prank(outsider);
        (address registry,) = factory.createBranch("osaka", expiry, branchOwner);
        assertTrue(registry != address(0));
    }

    function test_rejects_a_label_already_taken() public {
        _create("tokyo");
        vm.prank(org);
        vm.expectRevert(abi.encodeWithSelector(BranchFactory.LabelUnavailable.selector, "tokyo"));
        factory.createBranch("tokyo", expiry, branchOwner);
    }

    function test_rejects_invalid_labels() public {
        string[4] memory bad = ["Tokyo", "to kyo", "-tokyo", "tokyo-"];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(org);
            vm.expectRevert(
                abi.encodeWithSelector(BranchFactory.InvalidLabel.selector, bad[i])
            );
            factory.createBranch(bad[i], expiry, branchOwner);
        }
    }

    function test_rejects_a_past_expiry() public {
        uint64 past = uint64(block.timestamp);
        vm.prank(org);
        vm.expectRevert(abi.encodeWithSelector(BranchFactory.InvalidExpiry.selector, past));
        factory.createBranch("tokyo", past, branchOwner);
    }

    function test_rejects_a_zero_owner() public {
        vm.prank(org);
        vm.expectRevert(BranchFactory.InvalidOwner.selector);
        factory.createBranch("tokyo", expiry, address(0));
    }

    function test_availability_matches_what_create_will_do() public {
        assertTrue(factory.isAvailable("tokyo"));
        assertFalse(factory.isAvailable("Tokyo"), "invalid labels are never available");
        _create("tokyo");
        assertFalse(factory.isAvailable("tokyo"));
    }

    ////////////////////////////////////////////////////////////////////////
    // The assignee ceiling
    ////////////////////////////////////////////////////////////////////////

    /// EAC counts assignees in a 4-bit nybble and reverts at 15. Every branch takes a slot of
    /// ROLE_ENROL on the shared OrgRegistrar, so without retiring, the 16th branch an
    /// organization ever opens fails permanently. This was hit for real on Sepolia.
    function test_the_assignee_ceiling_is_real() public {
        // EAC counts assignees per role per resource in a 4-bit nybble and reverts at 15. Every
        // branch takes one slot of ROLE_ENROL on the shared OrgRegistrar, so an organization can
        // open a bounded number of branches, ever. This was hit for real on Sepolia — the 16th
        // `createBranch` reverted EACMaxAssignees and the only remedy was revoking by hand.
        uint256 enrol = orgRegistrar.ROLE_ENROL();
        uint256 granted;
        for (uint256 i = 1; i < 32; ++i) {
            vm.prank(org);
            try orgRegistrar.grantRootRoles(enrol, address(uint160(0xE000 + i))) {
                granted++;
            } catch {
                break;
            }
        }
        // The constructor already granted one, so the ceiling is reached before 15 more.
        assertLt(granted, 15, "the nybble saturates");
        assertGt(granted, 0, "but not immediately");
    }

    /// Retiring a branch hands its slot back, which is the only reason the ceiling is survivable.
    function test_retiring_a_branch_frees_its_slot() public {
        (, address registrar) = _create("tokyo");
        assertTrue(
            orgRegistrar.hasRootRoles(orgRegistrar.ROLE_ENROL(), registrar),
            "a live branch may enrol Members"
        );

        vm.prank(org);
        factory.retireBranch(registrar);

        assertFalse(
            orgRegistrar.hasRootRoles(orgRegistrar.ROLE_ENROL(), registrar),
            "a retired one may not"
        );
        assertFalse(resolver.rootWriter(registrar), "and may no longer write records");
    }

    function test_only_a_branch_creator_may_retire_one() public {
        (, address registrar) = _create("tokyo");
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(BranchFactory.NotABranchCreator.selector, outsider)
        );
        factory.retireBranch(registrar);
    }

    ////////////////////////////////////////////////////////////////////////
    // Two branches coexist
    ////////////////////////////////////////////////////////////////////////

    function test_branches_are_independent() public {
        (address tokyoRegistry, address tokyoRegistrar) = _create("tokyo");
        (address osakaRegistry, address osakaRegistrar) = _create("osaka");

        assertTrue(tokyoRegistry != osakaRegistry && tokyoRegistrar != osakaRegistrar);
        assertTrue(
            factory.branchNode("tokyo") != factory.branchNode("osaka"), "distinct namehashes"
        );

        // A registrar has no authority over the other branch's registry.
        assertFalse(
            PermissionedRegistry(osakaRegistry).hasRootRoles(
                RegistryRolesLib.ROLE_REGISTRAR, tokyoRegistrar
            ),
            "tokyo cannot mint into osaka"
        );
    }
}
