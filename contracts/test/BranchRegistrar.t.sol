// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BranchRegistrar} from "../src/BranchRegistrar.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {LabelStore} from "@ens-v2/utils/LabelStore.sol";
import {IContractNamer} from "@ens-v2/reverse-registrar/interfaces/IContractNamer.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";

contract BranchRegistrarTest is Test {
    PermissionedRegistry internal registry;
    BranchRegistrar internal registrar;

    address internal admin = makeAddr("organizer");
    address internal volunteer = makeAddr("volunteer");
    address internal outsider = makeAddr("outsider");
    address internal leo = makeAddr("leo");
    address internal ann = makeAddr("ann");

    address internal resolver = makeAddr("resolver");
    uint64 internal branchExpiry;

    // Cached: reading a constant via an external getter would consume vm.prank.
    uint256 internal ONBOARD;
    uint256 internal PROMOTE;

    function setUp() public {
        branchExpiry = uint64(block.timestamp + 30 days);

        LabelStore labelStore = new LabelStore(IContractNamer(address(0)));
        // This test contract is registry root so it can authorise the registrar.
        registry = new PermissionedRegistry(
            ILabelStore(address(labelStore)),
            address(this),
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_REGISTRAR_ADMIN
                | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_RENEW_ADMIN
                | RegistryRolesLib.ROLE_UNREGISTER | RegistryRolesLib.ROLE_UNREGISTER_ADMIN
                | RegistryRolesLib.ROLE_SET_RESOLVER | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN
                | RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN
        );

        registrar = new BranchRegistrar(
            IPermissionedRegistry(address(registry)), resolver, branchExpiry, admin
        );

        // No human ever holds ROLE_REGISTRAR — the registrar does.
        registry.grantRootRoles(registrar.REQUIRED_REGISTRY_ROLES(), address(registrar));

        ONBOARD = registrar.ROLE_ONBOARD();
        PROMOTE = registrar.ROLE_PROMOTE();

        // A volunteer may onboard, but holds no ROLE_PROMOTE.
        vm.prank(admin);
        registrar.grantRootRoles(ONBOARD, volunteer);
    }

    ////////////////////////////////////////////////////////////////////////
    // Onboarding
    ////////////////////////////////////////////////////////////////////////

    function test_organizer_onboards_a_hacker() public {
        vm.prank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);

        assertEq(registry.getOwner(resource), leo, "leo owns the name");
        assertEq(uint8(registrar.roleOf(resource)), uint8(BranchRegistrar.Role.Hacker));
        assertEq(registry.getExpiry(resource), branchExpiry, "membership expires with the branch");

        (bool exists,, BranchRegistrar.Role role) = registrar.membership(leo);
        assertTrue(exists);
        assertEq(uint8(role), uint8(BranchRegistrar.Role.Hacker));
    }

    function test_volunteer_can_onboard_a_hacker() public {
        vm.prank(volunteer);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);
        assertEq(registry.getOwner(resource), leo);
    }

    /// The whole reason the registrar exists: EAC cannot express this restriction.
    function test_volunteer_cannot_mint_an_organizer() public {
        vm.prank(volunteer);
        vm.expectRevert(
            abi.encodeWithSelector(
                BranchRegistrar.CannotGrantRole.selector, volunteer, BranchRegistrar.Role.Organizer
            )
        );
        registrar.onboard("ann", ann, BranchRegistrar.Role.Organizer);
    }

    function test_outsider_cannot_onboard() public {
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(BranchRegistrar.NotAnOnboarder.selector, outsider)
        );
        registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);
    }

    function test_one_membership_per_wallet() public {
        vm.startPrank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);
        vm.expectRevert(
            abi.encodeWithSelector(BranchRegistrar.AlreadyOnboarded.selector, leo, resource)
        );
        registrar.onboard("leo2", leo, BranchRegistrar.Role.Hacker);
        vm.stopPrank();
    }

    function test_label_must_be_available() public {
        vm.startPrank(admin);
        registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);
        vm.expectRevert(abi.encodeWithSelector(BranchRegistrar.LabelUnavailable.selector, "leo"));
        registrar.onboard("leo", ann, BranchRegistrar.Role.Hacker);
        vm.stopPrank();
    }

    function test_rejects_invalid_labels() public {
        string[5] memory bad = ["LEO", "le o", "-leo", "leo-", unicode"lEø"];
        vm.startPrank(admin);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(BranchRegistrar.InvalidLabel.selector, bad[i]));
            registrar.onboard(bad[i], leo, BranchRegistrar.Role.Hacker);
        }
        vm.stopPrank();
    }

    function test_rejects_empty_and_overlong_labels() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(BranchRegistrar.InvalidLabel.selector, ""));
        registrar.onboard("", leo, BranchRegistrar.Role.Hacker);

        string memory tooLong = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 33
        vm.expectRevert(abi.encodeWithSelector(BranchRegistrar.InvalidLabel.selector, tooLong));
        registrar.onboard(tooLong, leo, BranchRegistrar.Role.Hacker);
        vm.stopPrank();
    }

    ////////////////////////////////////////////////////////////////////////
    // Role bitmaps
    ////////////////////////////////////////////////////////////////////////

    /// "A hacker cannot edit their own records" is ENSv2's default, not something we implement.
    function test_hacker_holds_no_registry_roles() public {
        vm.prank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);

        assertFalse(
            registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_RESOLVER, leo),
            "hacker cannot set its resolver"
        );
        assertFalse(
            registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_SUBREGISTRY, leo),
            "hacker cannot create subnames"
        );
    }

    function test_partner_may_set_its_own_resolver() public {
        vm.prank(admin);
        uint256 resource = registrar.onboard("nova", ann, BranchRegistrar.Role.Partner);
        assertTrue(registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_RESOLVER, ann));
        assertFalse(registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_SUBREGISTRY, ann));
    }

    /// Withholding ROLE_CAN_TRANSFER_ADMIN is what makes a membership soulbound.
    function test_memberships_are_soulbound() public view {
        for (uint8 i = 0; i <= uint8(BranchRegistrar.Role.Organizer); ++i) {
            assertEq(
                registrar.registryBitmapFor(BranchRegistrar.Role(i))
                    & RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN,
                0,
                "no role may transfer"
            );
        }
    }

    /// ENSv2 blocks granting admin roles on an existing name, so a membership that held one could
    /// never be demoted out of it. Members therefore hold none.
    function test_memberships_hold_no_admin_roles() public view {
        uint256 adminHalf = type(uint256).max << 128;
        for (uint8 i = 0; i <= uint8(BranchRegistrar.Role.Organizer); ++i) {
            assertEq(
                registrar.registryBitmapFor(BranchRegistrar.Role(i)) & adminHalf,
                0,
                "no member holds an admin role"
            );
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // Promote / revoke
    ////////////////////////////////////////////////////////////////////////

    function test_promote_rewrites_registry_roles() public {
        vm.startPrank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);
        assertFalse(registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_RESOLVER, leo));

        registrar.promote(resource, BranchRegistrar.Role.Partner);
        vm.stopPrank();

        assertEq(uint8(registrar.roleOf(resource)), uint8(BranchRegistrar.Role.Partner));
        assertTrue(registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_RESOLVER, leo));
    }

    /// Reversible, unlike ENSv1 fuses — that is the point of EAC.
    function test_promote_is_reversible() public {
        vm.startPrank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);
        registrar.promote(resource, BranchRegistrar.Role.Partner);
        registrar.promote(resource, BranchRegistrar.Role.Hacker);
        vm.stopPrank();

        assertFalse(registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_RESOLVER, leo));
        assertEq(uint8(registrar.roleOf(resource)), uint8(BranchRegistrar.Role.Hacker));
    }

    function test_volunteer_cannot_promote() public {
        vm.prank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);

        vm.prank(volunteer);
        vm.expectRevert(
            abi.encodeWithSelector(
                BranchRegistrar.CannotGrantRole.selector, volunteer, BranchRegistrar.Role.Organizer
            )
        );
        registrar.promote(resource, BranchRegistrar.Role.Organizer);
    }

    function test_revoke_ends_the_membership() public {
        vm.startPrank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);
        registrar.revoke(resource);
        vm.stopPrank();

        (bool exists,,) = registrar.membership(leo);
        assertFalse(exists, "membership gone");
        assertTrue(registrar.isAvailable("leo"), "label freed");
    }

    function test_volunteer_cannot_revoke() public {
        vm.prank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);

        vm.prank(volunteer);
        vm.expectRevert(abi.encodeWithSelector(BranchRegistrar.NotARevoker.selector, volunteer));
        registrar.revoke(resource);
    }

    /// An organizer may hand out ROLE_ONBOARD because they hold its admin counterpart.
    function test_admin_role_lets_organizer_appoint_volunteers() public {
        address newVolunteer = makeAddr("newVolunteer");
        vm.prank(admin);
        registrar.grantRootRoles(ONBOARD, newVolunteer);

        vm.prank(newVolunteer);
        registrar.onboard("kenji", newVolunteer, BranchRegistrar.Role.Hacker);
    }

    function test_volunteer_cannot_appoint_volunteers() public {
        vm.prank(volunteer);
        vm.expectRevert(
            abi.encodeWithSignature(
                "EACCannotGrantRoles(uint256,uint256,address)", uint256(0), ONBOARD, volunteer
            )
        );
        registrar.grantRootRoles(ONBOARD, volunteer == outsider ? volunteer : outsider);
    }

    ////////////////////////////////////////////////////////////////////////
    // Fuzz
    ////////////////////////////////////////////////////////////////////////

    function testFuzz_valid_labels_onboard(uint8 len, uint256 seed) public {
        len = uint8(bound(len, 1, 32));
        bytes memory label = new bytes(len);
        bytes memory alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        for (uint256 i; i < len; ++i) {
            label[i] = alphabet[uint256(keccak256(abi.encode(seed, i))) % alphabet.length];
        }

        vm.prank(admin);
        uint256 resource = registrar.onboard(string(label), leo, BranchRegistrar.Role.Hacker);
        assertEq(registry.getOwner(resource), leo);
    }
}

/// @dev Onboards itself, then reenters from the ERC1155 mint callback to grab a second name.
contract ReentrantOnboarder {
    BranchRegistrar immutable REGISTRAR;
    bool attacked;

    constructor(BranchRegistrar registrar) {
        REGISTRAR = registrar;
    }

    function attack() external {
        REGISTRAR.onboard("first", address(this), BranchRegistrar.Role.Hacker);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        if (!attacked) {
            attacked = true;
            // Before the fix this slipped past the one-membership check, because
            // membershipOf[owner] was still unset at mint time.
            REGISTRAR.onboard("second", address(this), BranchRegistrar.Role.Hacker);
        }
        return this.onERC1155Received.selector;
    }
}

contract BranchRegistrarHardeningTest is BranchRegistrarTest {
    function test_reentrancy_cannot_mint_a_second_membership() public {
        ReentrantOnboarder attacker = new ReentrantOnboarder(registrar);
        vm.prank(admin);
        registrar.grantRootRoles(ONBOARD, address(attacker));

        vm.expectRevert(BranchRegistrar.Reentrancy.selector);
        attacker.attack();

        assertTrue(registrar.isAvailable("first"), "nothing was minted");
        assertTrue(registrar.isAvailable("second"));
    }

    /// The registry forgets owners once a name expires; our own record must not.
    function test_membership_survives_branch_expiry() public {
        vm.prank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);

        vm.warp(branchExpiry + 1 days);
        assertEq(registry.getOwner(resource), address(0), "registry has forgotten the owner");

        // Still revokable: bookkeeping no longer depends on registry liveness.
        vm.prank(admin);
        registrar.revoke(resource);
        (bool exists,,) = registrar.membership(leo);
        assertFalse(exists);
    }

    function test_renew_extends_past_the_branch_window() public {
        vm.prank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);

        uint64 later = branchExpiry + 30 days;
        vm.prank(admin);
        registrar.renew(resource, later);
        assertEq(registry.getExpiry(resource), later);
    }

    function test_volunteer_cannot_renew() public {
        vm.prank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);
        vm.prank(volunteer);
        vm.expectRevert(abi.encodeWithSelector(BranchRegistrar.NotARenewer.selector, volunteer));
        registrar.renew(resource, branchExpiry + 1 days);
    }

    /// A non-member must not read back as Hacker.
    function test_unknown_wallet_has_no_role() public view {
        (bool exists,, BranchRegistrar.Role role) = registrar.membership(address(0xdead));
        assertFalse(exists);
        assertEq(uint8(role), uint8(BranchRegistrar.Role.None), "deny by default");
    }

    function test_cannot_onboard_the_none_role() public {
        vm.prank(admin);
        vm.expectRevert(BranchRegistrar.InvalidRole.selector);
        registrar.onboard("leo", leo, BranchRegistrar.Role.None);
    }

    /// Desync escape hatch: the name is deleted behind the registrar's back.
    function test_release_unpins_a_desynced_wallet() public {
        vm.prank(admin);
        uint256 resource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);

        registry.unregister(resource); // this test contract holds root ROLE_UNREGISTER

        vm.prank(admin);
        registrar.releaseMembership(leo);

        vm.prank(admin);
        registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);
    }

    function test_constructor_rejects_a_past_expiry() public {
        vm.expectRevert(
            abi.encodeWithSelector(BranchRegistrar.InvalidExpiry.selector, uint64(block.timestamp))
        );
        new BranchRegistrar(
            IPermissionedRegistry(address(registry)), resolver, uint64(block.timestamp), admin
        );
    }
}
