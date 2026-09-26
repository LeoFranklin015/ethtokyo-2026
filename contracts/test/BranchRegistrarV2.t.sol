// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {BranchRegistrarV2, IBranchResolver} from "../src/BranchRegistrarV2.sol";
import {MockPermissionedResolver} from "./MockPermissionedResolver.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {OrgRegistrar} from "../src/OrgRegistrar.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {LabelStore} from "@ens-v2/utils/LabelStore.sol";
import {IContractNamer} from "@ens-v2/reverse-registrar/interfaces/IContractNamer.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";

contract BranchRegistrarV2Test is Test {
    PermissionedRegistry internal registry;
    PermissionedRegistry internal orgRegistry;
    BranchRegistrarV2 internal registrar;
    OrgRegistrar internal org;
    MockPermissionedResolver internal resolver;

    /// @dev \x05tokyo\x05ensca\x03eth\x00 — the DNS wire encoding the resolver re-hashes.
    bytes internal constant BRANCH_DNS_NAME = hex"05746f6b796f05656e7363610365746800";
    bytes32 internal BRANCH_NODE = NameCoder.namehash(BRANCH_DNS_NAME, 0);

    address internal organizer = _who(1);

    /// @dev Deterministic low addresses, guaranteed to hold no code. `makeAddr` derives realistic
    ///      addresses which can collide with live contracts when these tests run against a fork —
    ///      `_who(11)` is a deployed contract on Sepolia — and an ERC1155 mint to an
    ///      address with code invokes `onERC1155Received`, which then reverts.
    function _who(uint160 n) internal pure returns (address) {
        return address(0xA000 + n);
    }
    uint64 internal branchExpiry;

    bytes32 internal HACKER;
    bytes32 internal VOLUNTEER;
    bytes32 internal MENTOR;
    bytes32 internal ORGANIZER;

    // Cached: reading a constant through an external getter would consume vm.prank.
    uint256 internal MINT;

    function setUp() public {
        branchExpiry = uint64(block.timestamp + 30 days);
        resolver = new MockPermissionedResolver();

        registry = new PermissionedRegistry(
            ILabelStore(address(new LabelStore(IContractNamer(address(0))))),
            address(this),
            EACBaseRolesLib.ALL_ROLES
        );
        orgRegistry = new PermissionedRegistry(
            ILabelStore(address(new LabelStore(IContractNamer(address(0))))),
            address(this),
            EACBaseRolesLib.ALL_ROLES
        );
        org = new OrgRegistrar(
            IPermissionedRegistry(address(orgRegistry)),
            address(resolver),
            branchExpiry,
            organizer
        );
        orgRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW, address(org)
        );

        registrar = new BranchRegistrarV2(
            IPermissionedRegistry(address(registry)),
            IBranchResolver(address(resolver)),
            branchExpiry,
            organizer,
            org,
            BRANCH_NODE,
            BRANCH_DNS_NAME
        );
        // The branch registrar enrols Members on the organization's behalf.
        // NB: read the constant first — an external getter would consume the prank.
        resolver.grantRootRoles(0, address(registrar));
        uint256 enrol = org.ROLE_ENROL();
        vm.prank(organizer);
        org.grantRootRoles(enrol, address(registrar));
        registry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW
                | RegistryRolesLib.ROLE_UNREGISTER | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN
                | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN,
            address(registrar)
        );

        MINT = registrar.ROLE_MINT();
        HACKER = registrar.roleId("hacker");
        VOLUNTEER = registrar.roleId("volunteer");
        MENTOR = registrar.roleId("mentor");
        ORGANIZER = registrar.roleId("organizer");

        string[] memory none = new string[](0);
        BranchRegistrarV2.Entitlement[] memory noGrants = new BranchRegistrarV2.Entitlement[](0);

        // A hacker may write nothing at all.
        vm.prank(organizer);
        registrar.defineRole("hacker", 0, false, true, none, noGrants);

        // A volunteer may onboard anyone whose role is open, and edit only their own avatar.
        string[] memory volunteerKeys = new string[](1);
        volunteerKeys[0] = "avatar";
        vm.prank(organizer);
        registrar.defineRole("volunteer", 0, true, false, volunteerKeys, noGrants);

        // A mentor may edit two operational keys on their own name, but not their role.
        string[] memory mentorKeys = new string[](2);
        mentorKeys[0] = "avatar";
        mentorKeys[1] = "ssh.pubkey";
        vm.prank(organizer);
        registrar.defineRole("mentor", 0, false, false, mentorKeys, noGrants);

        vm.prank(organizer);
        registrar.defineRole("organizer", 0, true, false, none, noGrants);
    }

    function _node(string memory label) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(BRANCH_NODE, keccak256(bytes(label))));
    }

    ////////////////////////////////////////////////////////////////////////
    // The ceiling, and how the hook removes it
    ////////////////////////////////////////////////////////////////////////

    /// EAC counts assignees in a 4-bit nybble, so an explicit grant caps out at 15 holders.
    function test_explicit_grants_hit_the_15_assignee_ceiling() public {
        uint256 resource = registrar.roleResource(HACKER);

        vm.startPrank(organizer);
        for (uint256 i; i < 15; ++i) {
            assertTrue(
                registrar.grantRoles(resource, MINT, address(uint160(0x1000 + i))), "grant landed"
            );
        }
        console.log("assignee nybble after 15 grants:", registrar.roleCount(resource) & 0xf);

        // The sixteenth is refused by EAC itself.
        vm.expectRevert(abi.encodeWithSignature("EACMaxAssignees(uint256,uint256)", resource, MINT));
        registrar.grantRoles(resource, MINT, address(uint160(0x2000)));
        vm.stopPrank();
    }

    /// Derived authority writes no storage, so it never reaches `_roleCount`.
    function test_unlimited_volunteers_can_onboard() public {
        uint256 count = 30; // twice the ceiling an explicit grant would allow

        // Onboard the volunteers themselves. Nobody is granted ROLE_MINT.
        for (uint256 i; i < count; ++i) {
            address volunteer = address(uint160(0x5000 + i));
            vm.prank(organizer);
            registrar.onboard(string.concat("vol", vm.toString(i)), volunteer, VOLUNTEER, "");
        }

        // Every one of them can now mint a hacker, purely because their own role says so.
        for (uint256 i; i < count; ++i) {
            address volunteer = address(uint160(0x5000 + i));
            address hacker = address(uint160(0x9000 + i));
            vm.prank(volunteer);
            uint256 resource =
                registrar.onboard(string.concat("hack", vm.toString(i)), hacker, HACKER, "");
            assertEq(registry.getOwner(resource), hacker);
        }

        // And EAC still records zero assignees, because none of it was granted.
        uint256 assignees = registrar.roleCount(registrar.roleResource(HACKER));
        assertEq(assignees, 0, "no stored grants at all");
        assertEq(count, 30);
    }

    /// Authority is a property of the membership, so it appears and vanishes with the role.
    function test_authority_follows_the_membership() public {
        address marco = _who(10);

        vm.prank(organizer);
        registrar.onboard("marco", marco, VOLUNTEER, "");
        assertTrue(
            registrar.hasRoles(registrar.roleResource(HACKER), registrar.ROLE_MINT(), marco),
            "volunteer can mint"
        );

        // A hacker holds no minting authority at all.
        address kenji = _who(11);
        vm.prank(marco);
        registrar.onboard("kenji", kenji, HACKER, "");
        assertFalse(
            registrar.hasRoles(registrar.roleResource(HACKER), registrar.ROLE_MINT(), kenji),
            "hacker cannot mint"
        );

        vm.prank(kenji);
        vm.expectRevert(
            abi.encodeWithSelector(BranchRegistrarV2.CannotMintRole.selector, kenji, HACKER)
        );
        registrar.onboard("nope", _who(13), HACKER, "");
    }

    /// A volunteer may only mint roles the organization flagged open.
    function test_volunteer_cannot_mint_a_closed_role() public {
        address marco = _who(10);
        vm.prank(organizer);
        registrar.onboard("marco", marco, VOLUNTEER, "");

        vm.prank(marco);
        vm.expectRevert(
            abi.encodeWithSelector(BranchRegistrarV2.CannotMintRole.selector, marco, ORGANIZER)
        );
        registrar.onboard("mallory", _who(14), ORGANIZER, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // Per-key record permissions, at the same level
    ////////////////////////////////////////////////////////////////////////

    /// Two memberships side by side, differing only in role, with different record rights.
    function test_roles_at_the_same_level_get_different_record_rights() public {
        address kenji = _who(11);
        address priya = _who(12);

        vm.startPrank(organizer);
        registrar.onboard("kenji", kenji, HACKER, "");
        registrar.onboard("priya", priya, MENTOR, "");
        vm.stopPrank();

        // The mentor may write the two keys their role lists.
        vm.startPrank(priya);
        resolver.setText(_node("priya"), "avatar", "ipfs://priya");
        resolver.setText(_node("priya"), "ssh.pubkey", "ssh-ed25519 AAAA");
        vm.stopPrank();
        assertEq(resolver.text(_node("priya"), "avatar"), "ipfs://priya");
        assertEq(resolver.text(_node("priya"), "ssh.pubkey"), "ssh-ed25519 AAAA");

        // ...and nothing else. `wifi.rate` is an entitlement, not a profile field.
        vm.prank(priya);
        // The denial now comes from the resolver itself, on resource(node, partHash(key)) —
        // this registrar is not in the path at all.
        vm.expectRevert(
            abi.encodeWithSelector(
                MockPermissionedResolver.NotAuthorized.selector, priya, _node("priya"), "wifi.rate"
            )
        );
        resolver.setText(_node("priya"), "wifi.rate", "1000mbps");

        // The hacker, at the very same level, may write nothing.
        vm.prank(kenji);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockPermissionedResolver.NotAuthorized.selector, kenji, _node("kenji"), "avatar"
            )
        );
        resolver.setText(_node("kenji"), "avatar", "ipfs://kenji");
    }

    /// Redefining a role changes what new members get. Existing members hold rights in the
    /// resolver already, so catching them up is an explicit act — this pins that contract.
    function test_editing_the_catalogue_changes_existing_holders() public {
        address kenji = _who(11);
        vm.prank(organizer);
        registrar.onboard("kenji", kenji, HACKER, "");

        vm.prank(kenji);
        vm.expectRevert();
        resolver.setText(_node("kenji"), "avatar", "ipfs://kenji");

        // The organization decides hackers may set an avatar after all.
        string[] memory keys = new string[](1);
        keys[0] = "avatar";
        vm.prank(organizer);
        registrar.defineRole("hacker", 0, false, true, keys, new BranchRegistrarV2.Entitlement[](0));

        // A redefinition alone does not reach back into the resolver.
        vm.prank(kenji);
        vm.expectRevert();
        resolver.setText(_node("kenji"), "avatar", "ipfs://kenji");

        uint256 resource = registrar.membershipOf(kenji);
        vm.prank(organizer);
        registrar.syncMemberKeys(resource, new string[](0));

        vm.prank(kenji);
        resolver.setText(_node("kenji"), "avatar", "ipfs://kenji");
        assertEq(resolver.text(_node("kenji"), "avatar"), "ipfs://kenji");
    }

    /// An org can invent a role the contract never heard of, and it works immediately.
    function test_org_defines_an_entirely_new_role() public {
        string[] memory keys = new string[](1);
        keys[0] = "clinic.speciality";
        vm.prank(organizer);
        registrar.defineRole("trainer", 0, true, false, keys, new BranchRegistrarV2.Entitlement[](0));

        bytes32 TRAINER = registrar.roleId("trainer");
        address dana = _who(15);

        vm.prank(organizer);
        registrar.onboard("dana", dana, TRAINER, "");

        // The new role's own rights work.
        vm.prank(dana);
        resolver.setText(_node("dana"), "clinic.speciality", "strength");
        assertEq(resolver.text(_node("dana"), "clinic.speciality"), "strength");

        // And it inherited onboarding authority from its spec, with no grant.
        vm.prank(dana);
        registrar.onboard("client", _who(16), HACKER, "");
    }

    /// Named delegation still works, and is what the 15-cap is actually for.
    function test_named_delegate_can_mint_one_closed_role() public {
        address recruiter = _who(17);
        uint256 organizerResource = registrar.roleResource(ORGANIZER);
        vm.prank(organizer);
        registrar.grantRoles(organizerResource, MINT, recruiter);

        vm.prank(recruiter);
        registrar.onboard("ann", _who(18), ORGANIZER, "");

        // Scoped to that role only — hacker is open, so use another closed role to prove it.
        vm.prank(organizer);
        registrar.defineRole("auditor", 0, false, false, new string[](0), new BranchRegistrarV2.Entitlement[](0));
        bytes32 auditor = registrar.roleId("auditor");

        vm.prank(recruiter);
        vm.expectRevert(
            abi.encodeWithSelector(
                BranchRegistrarV2.CannotMintRole.selector, recruiter, auditor
            )
        );
        registrar.onboard("eve", _who(19), auditor, "");
    }
}

/// @notice The layers `docs/13` specifies that the first deployment left out: the Member name,
///         the organization-scoped fallback, entitlements at onboarding, and record clearing.
contract BranchRegistrarV2CompletenessTest is BranchRegistrarV2Test {
    function _grants() internal pure returns (BranchRegistrarV2.Entitlement[] memory g) {
        g = new BranchRegistrarV2.Entitlement[](3);
        g[0] = BranchRegistrarV2.Entitlement("role", "hacker");
        g[1] = BranchRegistrarV2.Entitlement("wifi.group", "hacker");
        g[2] = BranchRegistrarV2.Entitlement("wifi.rate", "5mbps");
    }

    ////////////////////////////////////////////////////////////////////////
    // Member layer
    ////////////////////////////////////////////////////////////////////////

    function test_onboarding_mints_the_member_name_once() public {
        address kenji = _who(11);

        vm.prank(organizer);
        registrar.onboard("kenji", kenji, HACKER, "kenji");

        assertTrue(org.isMember(kenji), "member name minted at first onboarding");
        assertEq(orgRegistry.getOwner(uint256(keccak256("kenji"))), kenji, "member owns it");
        assertEq(org.labelOf(kenji), "kenji");
    }

    /// The Member name is the identity that survives a branch ending.
    function test_member_name_survives_revocation() public {
        address kenji = _who(11);

        vm.startPrank(organizer);
        uint256 resource = registrar.onboard("kenji", kenji, HACKER, "kenji");
        uint256 memberResource = org.memberOf(kenji);
        registrar.revoke(resource);
        vm.stopPrank();

        assertEq(org.memberOf(kenji), memberResource, "member name untouched");
        assertEq(
            uint8(orgRegistry.getStatus(uint256(keccak256("kenji")))),
            uint8(IPermissionedRegistry.Status.REGISTERED),
            "member name still registered"
        );
        // ...while the membership itself is gone.
        assertEq(
            uint8(registry.getStatus(uint256(keccak256("kenji")))),
            uint8(IPermissionedRegistry.Status.AVAILABLE),
            "membership freed"
        );
    }

    /// Minted once ever: a second branch reuses the same Member name.
    function test_second_onboarding_reuses_the_member_name() public {
        address kenji = _who(11);

        vm.startPrank(organizer);
        uint256 first = registrar.onboard("kenji", kenji, HACKER, "kenji");
        uint256 memberResource = org.memberOf(kenji);
        registrar.revoke(first);
        registrar.onboard("kenji2", kenji, HACKER, "kenji");
        vm.stopPrank();

        assertEq(org.memberOf(kenji), memberResource, "same member name, not a second one");
    }

    ////////////////////////////////////////////////////////////////////////
    // Organization-scoped fallback
    ////////////////////////////////////////////////////////////////////////

    /// docs/13 §5.4: Membership here → else org-scoped role → else deny.
    function test_org_scoped_role_applies_without_a_membership() public {
        address dana = _who(15);

        (bytes32 role, bool fromOrg) = registrar.effectiveRole(dana);
        assertEq(role, bytes32(0), "a stranger has no role");
        assertFalse(fromOrg);

        vm.prank(organizer);
        org.setOrgRole(dana, VOLUNTEER);

        (role, fromOrg) = registrar.effectiveRole(dana);
        assertEq(role, VOLUNTEER, "org role applies at this branch");
        assertTrue(fromOrg, "and is flagged as coming from the organization");
    }

    /// An org-scoped volunteer can onboard here without ever being onboarded here themselves.
    function test_org_scoped_role_confers_authority_at_every_branch() public {
        address dana = _who(15);
        vm.prank(organizer);
        org.setOrgRole(dana, VOLUNTEER);

        vm.prank(dana);
        uint256 resource = registrar.onboard("client", _who(16), HACKER, "client");
        assertEq(registry.getOwner(resource), _who(16));
    }

    /// A Membership at this branch overrides the organization-wide role.
    function test_membership_overrides_the_org_role() public {
        address dana = _who(15);
        vm.prank(organizer);
        org.setOrgRole(dana, VOLUNTEER);

        vm.prank(organizer);
        registrar.onboard("dana", dana, HACKER, "dana");

        (bytes32 role, bool fromOrg) = registrar.effectiveRole(dana);
        assertEq(role, HACKER, "the local membership wins");
        assertFalse(fromOrg);

        // And the authority the org role would have conferred is gone.
        vm.prank(dana);
        vm.expectRevert(
            abi.encodeWithSelector(BranchRegistrarV2.CannotMintRole.selector, dana, HACKER)
        );
        registrar.onboard("nope", _who(13), HACKER, "nope");
    }

    ////////////////////////////////////////////////////////////////////////
    // Entitlements written at onboarding, cleared at revocation
    ////////////////////////////////////////////////////////////////////////

    function test_entitlements_are_written_in_the_onboarding_transaction() public {
        vm.prank(organizer);
        registrar.defineRole("hacker", 0, false, true, new string[](0), _grants());

        address kenji = _who(11);
        vm.prank(organizer);
        registrar.onboard("kenji", kenji, HACKER, "kenji");

        bytes32 node = registrar.membershipNode("kenji");
        assertEq(resolver.text(node, "role"), "hacker");
        assertEq(resolver.text(node, "wifi.group"), "hacker");
        assertEq(resolver.text(node, "wifi.rate"), "5mbps");
    }

    /// Records are written at the true ENS namehash, not at a label-only hash.
    function test_records_land_at_the_real_namehash() public {
        vm.prank(organizer);
        registrar.defineRole("hacker", 0, false, true, new string[](0), _grants());

        vm.prank(organizer);
        registrar.onboard("kenji", _who(11), HACKER, "kenji");

        bytes32 expected = keccak256(abi.encodePacked(BRANCH_NODE, keccak256("kenji")));
        assertEq(registrar.membershipNode("kenji"), expected);
        assertEq(resolver.text(expected, "role"), "hacker");
        // The label-only hash — the bug the first deployment shipped — stays empty.
        assertEq(resolver.text(keccak256(abi.encodePacked(bytes32(0), keccak256("kenji"))), "role"), "");
    }

    function test_revocation_clears_the_records() public {
        vm.prank(organizer);
        registrar.defineRole("hacker", 0, false, true, new string[](0), _grants());

        address kenji = _who(11);
        vm.startPrank(organizer);
        uint256 resource = registrar.onboard("kenji", kenji, HACKER, "kenji");
        bytes32 node = registrar.membershipNode("kenji");
        assertEq(resolver.text(node, "wifi.rate"), "5mbps");

        registrar.revoke(resource);
        vm.stopPrank();

        assertEq(resolver.text(node, "role"), "", "entitlements cleared");
        assertEq(resolver.text(node, "wifi.group"), "");
        assertEq(resolver.text(node, "wifi.rate"), "");
    }

    /// Each role brings its own entitlements, so two members differ by role alone.
    function test_different_roles_get_different_entitlements() public {
        BranchRegistrarV2.Entitlement[] memory mentorGrants =
            new BranchRegistrarV2.Entitlement[](2);
        mentorGrants[0] = BranchRegistrarV2.Entitlement("role", "mentor");
        mentorGrants[1] = BranchRegistrarV2.Entitlement("wifi.rate", "20mbps");

        vm.startPrank(organizer);
        registrar.defineRole("hacker", 0, false, true, new string[](0), _grants());
        registrar.defineRole("mentor", 0, false, true, new string[](0), mentorGrants);
        registrar.onboard("kenji", _who(11), HACKER, "kenji");
        registrar.onboard("priya", _who(12), MENTOR, "priya");
        vm.stopPrank();

        assertEq(resolver.text(registrar.membershipNode("kenji"), "wifi.rate"), "5mbps");
        assertEq(resolver.text(registrar.membershipNode("priya"), "wifi.rate"), "20mbps");
    }
}
