// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {ModularBranchRegistrar, IBranchResolver} from "../src/prototype/ModularBranchRegistrar.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {LabelStore} from "@ens-v2/utils/LabelStore.sol";
import {IContractNamer} from "@ens-v2/reverse-registrar/interfaces/IContractNamer.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";

/// @dev Stands in for the branch resolver. Records who wrote what, so the tests can assert on
///      authority without also exercising the resolver's own argument-scoped role machinery.
contract StubResolver is IBranchResolver {
    mapping(bytes32 => mapping(string => string)) public records;

    function setText(bytes32 node, string calldata key, string calldata value) external {
        records[node][key] = value;
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return records[node][key];
    }
}

contract ModularBranchRegistrarTest is Test {
    PermissionedRegistry internal registry;
    ModularBranchRegistrar internal registrar;
    StubResolver internal resolver;

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
        resolver = new StubResolver();

        registry = new PermissionedRegistry(
            ILabelStore(address(new LabelStore(IContractNamer(address(0))))),
            address(this),
            EACBaseRolesLib.ALL_ROLES
        );
        registrar = new ModularBranchRegistrar(
            IPermissionedRegistry(address(registry)),
            IBranchResolver(address(resolver)),
            branchExpiry,
            organizer
        );
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

        // A hacker may write nothing at all.
        vm.prank(organizer);
        registrar.defineRole("hacker", 0, false, true, none);

        // A volunteer may onboard anyone whose role is open, and edit only their own avatar.
        string[] memory volunteerKeys = new string[](1);
        volunteerKeys[0] = "avatar";
        vm.prank(organizer);
        registrar.defineRole("volunteer", 0, true, false, volunteerKeys);

        // A mentor may edit two operational keys on their own name, but not their role.
        string[] memory mentorKeys = new string[](2);
        mentorKeys[0] = "avatar";
        mentorKeys[1] = "ssh.pubkey";
        vm.prank(organizer);
        registrar.defineRole("mentor", 0, false, false, mentorKeys);

        vm.prank(organizer);
        registrar.defineRole("organizer", 0, true, false, none);
    }

    function _node(string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes32(0), keccak256(bytes(label))));
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
            registrar.onboard(string.concat("vol", vm.toString(i)), volunteer, VOLUNTEER);
        }

        // Every one of them can now mint a hacker, purely because their own role says so.
        for (uint256 i; i < count; ++i) {
            address volunteer = address(uint160(0x5000 + i));
            address hacker = address(uint160(0x9000 + i));
            vm.prank(volunteer);
            uint256 resource =
                registrar.onboard(string.concat("hack", vm.toString(i)), hacker, HACKER);
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
        registrar.onboard("marco", marco, VOLUNTEER);
        assertTrue(
            registrar.hasRoles(registrar.roleResource(HACKER), registrar.ROLE_MINT(), marco),
            "volunteer can mint"
        );

        // A hacker holds no minting authority at all.
        address kenji = _who(11);
        vm.prank(marco);
        registrar.onboard("kenji", kenji, HACKER);
        assertFalse(
            registrar.hasRoles(registrar.roleResource(HACKER), registrar.ROLE_MINT(), kenji),
            "hacker cannot mint"
        );

        vm.prank(kenji);
        vm.expectRevert(
            abi.encodeWithSelector(ModularBranchRegistrar.CannotMintRole.selector, kenji, HACKER)
        );
        registrar.onboard("nope", _who(13), HACKER);
    }

    /// A volunteer may only mint roles the organization flagged open.
    function test_volunteer_cannot_mint_a_closed_role() public {
        address marco = _who(10);
        vm.prank(organizer);
        registrar.onboard("marco", marco, VOLUNTEER);

        vm.prank(marco);
        vm.expectRevert(
            abi.encodeWithSelector(ModularBranchRegistrar.CannotMintRole.selector, marco, ORGANIZER)
        );
        registrar.onboard("mallory", _who(14), ORGANIZER);
    }

    ////////////////////////////////////////////////////////////////////////
    // Per-key record permissions, at the same level
    ////////////////////////////////////////////////////////////////////////

    /// Two memberships side by side, differing only in role, with different record rights.
    function test_roles_at_the_same_level_get_different_record_rights() public {
        address kenji = _who(11);
        address priya = _who(12);

        vm.startPrank(organizer);
        registrar.onboard("kenji", kenji, HACKER);
        registrar.onboard("priya", priya, MENTOR);
        vm.stopPrank();

        // The mentor may write the two keys their role lists.
        vm.startPrank(priya);
        registrar.setOwnRecord("avatar", "ipfs://priya", _node("priya"));
        registrar.setOwnRecord("ssh.pubkey", "ssh-ed25519 AAAA", _node("priya"));
        vm.stopPrank();
        assertEq(resolver.text(_node("priya"), "avatar"), "ipfs://priya");
        assertEq(resolver.text(_node("priya"), "ssh.pubkey"), "ssh-ed25519 AAAA");

        // ...and nothing else. `wifi.rate` is an entitlement, not a profile field.
        vm.prank(priya);
        vm.expectRevert(
            abi.encodeWithSelector(
                ModularBranchRegistrar.CannotEditKey.selector, priya, "wifi.rate"
            )
        );
        registrar.setOwnRecord("wifi.rate", "1000mbps", _node("priya"));

        // The hacker, at the very same level, may write nothing.
        vm.prank(kenji);
        vm.expectRevert(
            abi.encodeWithSelector(ModularBranchRegistrar.CannotEditKey.selector, kenji, "avatar")
        );
        registrar.setOwnRecord("avatar", "ipfs://kenji", _node("kenji"));
    }

    /// Redefining a role changes what its existing holders may do, with no per-member work.
    function test_editing_the_catalogue_changes_existing_holders() public {
        address kenji = _who(11);
        vm.prank(organizer);
        registrar.onboard("kenji", kenji, HACKER);

        vm.prank(kenji);
        vm.expectRevert();
        registrar.setOwnRecord("avatar", "ipfs://kenji", _node("kenji"));

        // The organization decides hackers may set an avatar after all.
        string[] memory keys = new string[](1);
        keys[0] = "avatar";
        vm.prank(organizer);
        registrar.defineRole("hacker", 0, false, true, keys);

        vm.prank(kenji);
        registrar.setOwnRecord("avatar", "ipfs://kenji", _node("kenji"));
        assertEq(resolver.text(_node("kenji"), "avatar"), "ipfs://kenji");
    }

    /// An org can invent a role the contract never heard of, and it works immediately.
    function test_org_defines_an_entirely_new_role() public {
        string[] memory keys = new string[](1);
        keys[0] = "clinic.speciality";
        vm.prank(organizer);
        registrar.defineRole("trainer", 0, true, false, keys);

        bytes32 TRAINER = registrar.roleId("trainer");
        address dana = _who(15);

        vm.prank(organizer);
        registrar.onboard("dana", dana, TRAINER);

        // The new role's own rights work.
        vm.prank(dana);
        registrar.setOwnRecord("clinic.speciality", "strength", _node("dana"));
        assertEq(resolver.text(_node("dana"), "clinic.speciality"), "strength");

        // And it inherited onboarding authority from its spec, with no grant.
        vm.prank(dana);
        registrar.onboard("client", _who(16), HACKER);
    }

    /// Named delegation still works, and is what the 15-cap is actually for.
    function test_named_delegate_can_mint_one_closed_role() public {
        address recruiter = _who(17);
        uint256 organizerResource = registrar.roleResource(ORGANIZER);
        vm.prank(organizer);
        registrar.grantRoles(organizerResource, MINT, recruiter);

        vm.prank(recruiter);
        registrar.onboard("ann", _who(18), ORGANIZER);

        // Scoped to that role only — hacker is open, so use another closed role to prove it.
        vm.prank(organizer);
        registrar.defineRole("auditor", 0, false, false, new string[](0));
        bytes32 auditor = registrar.roleId("auditor");

        vm.prank(recruiter);
        vm.expectRevert(
            abi.encodeWithSelector(
                ModularBranchRegistrar.CannotMintRole.selector, recruiter, auditor
            )
        );
        registrar.onboard("eve", _who(19), auditor);
    }
}
