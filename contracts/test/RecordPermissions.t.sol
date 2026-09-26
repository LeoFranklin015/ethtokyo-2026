// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BranchRegistrarV2, IBranchResolver} from "../src/BranchRegistrarV2.sol";
import {OrgRegistrar} from "../src/OrgRegistrar.sol";
import {MockPermissionedResolver} from "./MockPermissionedResolver.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {LabelStore} from "@ens-v2/utils/LabelStore.sol";
import {IContractNamer} from "@ens-v2/reverse-registrar/interfaces/IContractNamer.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

/// @notice The record-permission matrix, as assertions.
///
/// @dev Who may write which text record on whose name is the question the whole design turns on,
///      and it used to be answered wrongly: `setOwnRecord` took the node from the caller, so a
///      member with one self-editable key could write that key at *any* name the shared resolver
///      served — a sibling branch's members, the branch node, the `ensca.registrar` discovery
///      record that the console trusts to find registrars.
///
///      The fix is to stop mediating and use what ENSv2 already provides: `authorizeTextRoles`
///      scopes `ROLE_SET_TEXT` to `resource(namehash, partHash(key))`, both dimensions at once.
///      The registrar hands a member exactly that at onboarding; the resolver enforces it.
///      Every test below is written against the resolver, because that is now the enforcer.
contract RecordPermissionsTest is Test {
    PermissionedRegistry internal registry;
    PermissionedRegistry internal orgRegistry;
    BranchRegistrarV2 internal registrar;
    OrgRegistrar internal org;
    MockPermissionedResolver internal resolver;

    /// @dev \x05tokyo\x05ensca\x03eth\x00
    bytes internal constant BRANCH_DNS_NAME = hex"05746f6b796f05656e7363610365746800";
    bytes32 internal BRANCH_NODE = NameCoder.namehash(BRANCH_DNS_NAME, 0);

    address internal organizer = _who(1);
    address internal mentor = _who(2);
    address internal hacker = _who(3);
    address internal otherMentor = _who(4);
    address internal outsider = _who(9);

    bytes32 internal MENTOR;
    bytes32 internal HACKER;

    uint64 internal expiry;

    /// @dev Low, codeless addresses: `makeAddr` can collide with a real account that has code,
    ///      and an ERC1155 mint to a contract invokes `onERC1155Received`.
    function _who(uint160 n) internal pure returns (address) {
        return address(uint160(0xA000) + n);
    }

    function _node(string memory label) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(BRANCH_NODE, keccak256(bytes(label))));
    }

    function setUp() public {
        expiry = uint64(block.timestamp + 30 days);
        resolver = new MockPermissionedResolver();

        ILabelStore store = ILabelStore(address(new LabelStore(IContractNamer(address(0)))));
        registry = new PermissionedRegistry(store, address(this), EACBaseRolesLib.ALL_ROLES);
        orgRegistry = new PermissionedRegistry(store, address(this), EACBaseRolesLib.ALL_ROLES);

        org = new OrgRegistrar(
            IPermissionedRegistry(address(orgRegistry)), address(resolver), expiry, organizer
        );
        orgRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW, address(org)
        );

        registrar = new BranchRegistrarV2(
            IPermissionedRegistry(address(registry)),
            IBranchResolver(address(resolver)),
            expiry,
            organizer,
            org,
            BRANCH_NODE,
            BRANCH_DNS_NAME
        );
        resolver.grantRootRoles(0, address(registrar));
        uint256 enrol = org.ROLE_ENROL();
        vm.prank(organizer);
        org.grantRootRoles(enrol, address(registrar));
        registry.grantRootRoles(registrar.REQUIRED_REGISTRY_ROLES(), address(registrar));

        // A mentor may curate their own profile. A hacker may write nothing at all.
        string[] memory mentorKeys = new string[](2);
        mentorKeys[0] = "avatar";
        mentorKeys[1] = "ssh.pubkey";

        BranchRegistrarV2.Entitlement[] memory wifi = new BranchRegistrarV2.Entitlement[](1);
        wifi[0] = BranchRegistrarV2.Entitlement("wifi.rate", "20mbps");

        vm.startPrank(organizer);
        registrar.defineRole("mentor", 0, false, true, mentorKeys, wifi);
        registrar.defineRole(
            "hacker", 0, false, true, new string[](0), new BranchRegistrarV2.Entitlement[](0)
        );
        MENTOR = registrar.roleId("mentor");
        HACKER = registrar.roleId("hacker");
        registrar.onboard("mentor1", mentor, MENTOR, "");
        registrar.onboard("hacker1", hacker, HACKER, "");
        registrar.onboard("mentor2", otherMentor, MENTOR, "");
        vm.stopPrank();
    }

    ////////////////////////////////////////////////////////////////////////
    // What each actor may write
    ////////////////////////////////////////////////////////////////////////

    function test_mentor_writes_their_own_listed_keys() public {
        vm.startPrank(mentor);
        resolver.setText(_node("mentor1"), "avatar", "ipfs://mentor");
        resolver.setText(_node("mentor1"), "ssh.pubkey", "ssh-ed25519 AAAA");
        vm.stopPrank();

        assertEq(resolver.text(_node("mentor1"), "avatar"), "ipfs://mentor");
        assertEq(resolver.text(_node("mentor1"), "ssh.pubkey"), "ssh-ed25519 AAAA");
    }

    function test_mentor_cannot_write_a_key_their_role_does_not_list() public {
        vm.prank(mentor);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockPermissionedResolver.NotAuthorized.selector,
                mentor,
                _node("mentor1"),
                "wifi.rate"
            )
        );
        resolver.setText(_node("mentor1"), "wifi.rate", "1000mbps");
    }

    /// A hacker, at the same level as a mentor, may write nothing whatsoever.
    function test_hacker_cannot_write_anything() public {
        string[3] memory keys = ["avatar", "ssh.pubkey", "wifi.rate"];
        for (uint256 i; i < keys.length; ++i) {
            vm.prank(hacker);
            vm.expectRevert();
            resolver.setText(_node("hacker1"), keys[i], "x");
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // The bug this design exists to prevent
    ////////////////////////////////////////////////////////////////////////

    /// The fix, stated directly: a right to write `avatar` is a right to write it on ONE name.
    function test_mentor_cannot_write_on_another_members_name() public {
        vm.prank(mentor);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockPermissionedResolver.NotAuthorized.selector,
                mentor,
                _node("mentor2"),
                "avatar"
            )
        );
        resolver.setText(_node("mentor2"), "avatar", "ipfs://hijacked");
    }

    /// The discovery record the console trusts to locate a branch's registrar.
    function test_member_cannot_touch_the_branch_discovery_record() public {
        vm.prank(mentor);
        vm.expectRevert();
        resolver.setText(BRANCH_NODE, "ensca.registrar", "0xattacker");
    }

    function test_member_cannot_write_the_branch_node() public {
        vm.prank(mentor);
        vm.expectRevert();
        resolver.setText(BRANCH_NODE, "avatar", "x");
    }

    function test_outsider_can_write_nothing() public {
        vm.prank(outsider);
        vm.expectRevert();
        resolver.setText(_node("mentor1"), "avatar", "x");
    }

    ////////////////////////////////////////////////////////////////////////
    // Lifecycle of a delegated right
    ////////////////////////////////////////////////////////////////////////

    function test_revocation_takes_back_the_resolver_rights() public {
        assertTrue(resolver.mayWrite(_node("mentor1"), "avatar", mentor), "held before");

        uint256 resource = registrar.membershipOf(mentor);
        vm.prank(organizer);
        registrar.revoke(resource);

        assertFalse(resolver.mayWrite(_node("mentor1"), "avatar", mentor), "gone after");
        vm.prank(mentor);
        vm.expectRevert();
        resolver.setText(_node("mentor1"), "avatar", "ipfs://still-me");
    }

    /// Removing a key from the catalogue must actually remove it for anyone onboarded later.
    function test_a_key_removed_from_a_role_is_not_handed_to_new_members() public {
        string[] memory fewer = new string[](1);
        fewer[0] = "avatar";
        vm.prank(organizer);
        registrar.defineRole(
            "mentor", 0, false, true, fewer, new BranchRegistrarV2.Entitlement[](0)
        );

        address later = _who(20);
        vm.prank(organizer);
        registrar.onboard("mentor3", later, MENTOR, "");

        assertTrue(resolver.mayWrite(_node("mentor3"), "avatar", later));
        assertFalse(
            resolver.mayWrite(_node("mentor3"), "ssh.pubkey", later),
            "the withdrawn key is not delegated"
        );
    }

    function test_editable_keys_are_readable_back() public view {
        string[] memory keys = registrar.editableKeysOf(MENTOR);
        assertEq(keys.length, 2);
        assertEq(keys[0], "avatar");
        assertEq(keys[1], "ssh.pubkey");
        assertEq(registrar.editableKeysOf(HACKER).length, 0);
    }

    ////////////////////////////////////////////////////////////////////////
    // Staff writes
    ////////////////////////////////////////////////////////////////////////

    /// `setRecord` no longer takes a node, so a staff writer cannot aim it anywhere.
    function test_staff_write_lands_on_the_named_membership() public {
        uint256 resource = registrar.membershipOf(hacker);
        vm.prank(organizer);
        registrar.setRecord(resource, "wifi.rate", "50mbps");
        assertEq(resolver.text(_node("hacker1"), "wifi.rate"), "50mbps");
    }

    function test_a_member_cannot_use_the_staff_write() public {
        uint256 resource = registrar.membershipOf(hacker);
        vm.prank(mentor);
        vm.expectRevert(
            abi.encodeWithSelector(BranchRegistrarV2.CannotEditKey.selector, mentor, "wifi.rate")
        );
        registrar.setRecord(resource, "wifi.rate", "1000mbps");
    }

    ////////////////////////////////////////////////////////////////////////
    // Revocation is its own privilege
    ////////////////////////////////////////////////////////////////////////

    /// Fixing a typo in somebody's avatar and burning their name are not the same permission.
    function test_a_record_editor_cannot_revoke() public {
        address helper = _who(21);
        uint256 editRecord = registrar.ROLE_EDIT_RECORD();
        vm.prank(organizer);
        registrar.grantRootRoles(editRecord, helper);

        uint256 resource = registrar.membershipOf(hacker);
        vm.prank(helper);
        vm.expectRevert(
            abi.encodeWithSelector(BranchRegistrarV2.NotARevoker.selector, helper)
        );
        registrar.revoke(resource);
    }

    function test_a_revoker_can_revoke() public {
        address ender = _who(22);
        uint256 revokeRole = registrar.ROLE_REVOKE();
        vm.prank(organizer);
        registrar.grantRootRoles(revokeRole, ender);

        uint256 resource = registrar.membershipOf(hacker);
        vm.prank(ender);
        registrar.revoke(resource);
        assertEq(registrar.membershipOf(hacker), 0);
    }

    ////////////////////////////////////////////////////////////////////////
    // Catalogue authority
    ////////////////////////////////////////////////////////////////////////

    function test_only_a_role_editor_may_define_a_role() public {
        address[2] memory nobodies = [mentor, outsider];
        for (uint256 i; i < nobodies.length; ++i) {
            vm.prank(nobodies[i]);
            vm.expectRevert(
                abi.encodeWithSelector(BranchRegistrarV2.NotARoleEditor.selector, nobodies[i])
            );
            registrar.defineRole(
                "sneaky", 0, true, true, new string[](0), new BranchRegistrarV2.Entitlement[](0)
            );
        }
    }

    function test_a_retired_role_cannot_be_minted() public {
        vm.prank(organizer);
        registrar.retireRole(HACKER);

        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(BranchRegistrarV2.UnknownRole.selector, HACKER));
        registrar.onboard("hacker9", _who(30), HACKER, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // Onboarding guards
    ////////////////////////////////////////////////////////////////////////

    function test_rejects_a_label_ens_would_never_normalise() public {
        string[4] memory bad = ["Hacker", "has space", "-lead", "trail-"];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(organizer);
            vm.expectRevert(
                abi.encodeWithSelector(BranchRegistrarV2.InvalidLabel.selector, bad[i])
            );
            registrar.onboard(bad[i], _who(uint160(40 + i)), HACKER, "");
        }
    }

    function test_rejects_a_zero_owner() public {
        vm.prank(organizer);
        vm.expectRevert(BranchRegistrarV2.InvalidOwner.selector);
        registrar.onboard("nobody", address(0), HACKER, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // Expiry
    ////////////////////////////////////////////////////////////////////////

    /// A closed branch confers no authority — otherwise last year's organizer still mints.
    function test_authority_lapses_when_the_branch_closes() public {
        string[] memory none = new string[](0);
        BranchRegistrarV2.Entitlement[] memory noGrants = new BranchRegistrarV2.Entitlement[](0);
        vm.prank(organizer);
        registrar.defineRole("volunteer", 0, true, true, none, noGrants);
        bytes32 VOLUNTEER = registrar.roleId("volunteer");

        address vol = _who(50);
        vm.prank(organizer);
        registrar.onboard("vol1", vol, VOLUNTEER, "");

        // Before the window closes, the volunteer mints.
        vm.prank(vol);
        registrar.onboard("h2", _who(51), HACKER, "");

        vm.warp(expiry + 1);
        (bytes32 role,) = registrar.effectiveRole(vol);
        assertEq(role, bytes32(0), "an expired membership confers nothing");

        vm.prank(vol);
        vm.expectRevert(
            abi.encodeWithSelector(BranchRegistrarV2.CannotMintRole.selector, vol, HACKER)
        );
        registrar.onboard("h3", _who(52), HACKER, "");
    }
}
