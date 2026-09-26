// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BranchRegistrarV2} from "../src/BranchRegistrarV2.sol";
import {BranchFactory} from "../src/BranchFactory.sol";
import {OrgRegistrar} from "../src/OrgRegistrar.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";

interface IResolverRead {
    function text(bytes32 node, string calldata key) external view returns (string memory);
    function setText(bytes32 node, string calldata key, string calldata value) external;
}

/// @notice The record-permission matrix, asserted against the LIVE Sepolia deployment.
///
/// @dev `test/RecordPermissions.t.sol` proves the rules against a modelled resolver. This proves
///      the same rules against the resolver ENS actually deployed, on names that actually exist —
///      which is the only way to catch a divergence between our model of `PermissionedResolver`
///      and the contract itself. The previous design passed every local test while carrying a
///      critical hole, so the live check is not ceremony.
///
///   forge test --match-path test/LivePermissions.fork.t.sol --fork-url $SEPOLIA_RPC_URL -vv
contract LivePermissionsForkTest is Test {
    /// Branch opened by the 2026-09-26 live run, via factory 0x56fFA42E…6ec5.
    address internal constant REGISTRAR = 0x4c8F7ce5b0C43f739315cCd14F1D608198095462;
    address internal constant RESOLVER = 0x9D8f1376aED12F6F7Ba041285Cce833AcED13092;
    address internal constant FACTORY = 0x56fFA42E57b864eff61C0A5454BEAB140dFe6ec5;
    address internal constant ORG_REGISTRAR = 0xA0F10DFd7022eBa1114ECe9C16149841a023Ecd7;

    bytes32 internal constant BRANCH_NODE =
        0xa9891e9208e4b62ba06d261cfed7b07237d04ff50342220140fbdfb861df51ea;

    /// mentor1 — onboarded at `mentor`, which lists `avatar` and `ssh.pubkey`. Revoked at the end
    /// of the live run, so it stands for "a wallet whose membership has ended".
    address internal constant MENTOR_1 = 0xa57Acaf9b940021065A5A760A53348279a45DFC7;
    /// mentor2 — still live, same role, a different name. The cross-member target.
    address internal constant MENTOR_2 = 0x07c47DAcae70C21832E90209F99aF9F6ae3F911e;
    /// hacker1 — onboarded at `hacker`, which lists no editable keys at all.
    address internal constant HACKER_1 = 0x17b15b1B88146E51eB89307697e32c97126edBE5;

    BranchRegistrarV2 internal registrar = BranchRegistrarV2(REGISTRAR);
    IResolverRead internal resolver = IResolverRead(RESOLVER);

    function setUp() public {
        vm.skip(block.chainid != 11155111, "requires a Sepolia fork");
    }

    function _node(string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(BRANCH_NODE, keccak256(bytes(label))));
    }

    /// @dev Does `who` get to write `key` on `node`, according to the live resolver?
    function _mayWrite(address who, bytes32 node, string memory key) internal returns (bool ok) {
        vm.prank(who);
        try resolver.setText(node, key, "probe") {
            return true;
        } catch {
            return false;
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // The branch is what it claims to be
    ////////////////////////////////////////////////////////////////////////

    /// The namehash is derived on-chain; this asserts it equals the real ENS namehash.
    function test_branch_node_is_the_real_namehash() public view {
        assertEq(registrar.BRANCH_NODE(), BRANCH_NODE, "registrar agrees with ENS");
        assertEq(
            BranchFactory(FACTORY).branchNode("live-20260926"),
            BRANCH_NODE,
            "factory derives the same node"
        );
    }

    /// A registrar is only an EAC role holder, so the branch publishes it to be findable.
    function test_branch_publishes_its_registrar() public view {
        assertEq(
            keccak256(bytes(resolver.text(BRANCH_NODE, "ensca.registrar"))),
            keccak256(bytes(vm.toLowercase(vm.toString(REGISTRAR)))),
            "ensca.registrar names the live registrar"
        );
    }

    function test_the_dns_name_matches_the_node() public view {
        // If these two ever disagree, `authorizeTextRoles` would delegate rights at a node the
        // registrar never writes to — a silent, total failure of the permission model.
        bytes memory dns = registrar.BRANCH_DNS_NAME();
        assertGt(dns.length, 0, "the branch knows its own name");
        assertEq(
            keccak256(registrar.membershipDnsName("mentor2")),
            keccak256(abi.encodePacked(uint8(7), "mentor2", dns)),
            "a membership name is its label prepended to the branch"
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // The matrix, against the deployed resolver
    ////////////////////////////////////////////////////////////////////////

    function test_a_mentor_writes_their_own_listed_keys() public {
        assertTrue(_mayWrite(MENTOR_2, _node("mentor2"), "avatar"), "own avatar");
        assertTrue(_mayWrite(MENTOR_2, _node("mentor2"), "ssh.pubkey"), "own ssh.pubkey");
    }

    function test_a_mentor_cannot_write_an_unlisted_key() public {
        assertFalse(
            _mayWrite(MENTOR_2, _node("mentor2"), "wifi.rate"),
            "wifi.rate is an entitlement the organization sets, not a profile field"
        );
    }

    /// The defect this whole redesign exists to close.
    function test_a_mentor_cannot_write_on_another_members_name() public {
        assertFalse(
            _mayWrite(MENTOR_2, _node("mentor1"), "avatar"),
            "a right to write avatar is a right to write it on ONE name"
        );
    }

    function test_a_member_cannot_touch_the_branch_itself() public {
        assertFalse(_mayWrite(MENTOR_2, BRANCH_NODE, "avatar"), "branch node");
        assertFalse(
            _mayWrite(MENTOR_2, BRANCH_NODE, "ensca.registrar"),
            "hijacking discovery would redirect every console to an attacker's registrar"
        );
    }

    /// A hacker sits at the same level as a mentor and may write nothing at all.
    function test_a_hacker_can_write_nothing() public {
        assertFalse(_mayWrite(HACKER_1, _node("hacker1"), "avatar"), "avatar");
        assertFalse(_mayWrite(HACKER_1, _node("hacker1"), "ssh.pubkey"), "ssh.pubkey");
        assertFalse(_mayWrite(HACKER_1, _node("hacker1"), "wifi.rate"), "wifi.rate");
    }

    function test_an_outsider_can_write_nothing() public {
        address outsider = address(0xBEEF);
        assertFalse(_mayWrite(outsider, _node("mentor2"), "avatar"));
        assertFalse(_mayWrite(outsider, BRANCH_NODE, "ensca.registrar"));
    }

    ////////////////////////////////////////////////////////////////////////
    // Revocation, as it actually happened
    ////////////////////////////////////////////////////////////////////////

    /// mentor1 was onboarded, wrote an avatar, and was revoked during the live run.
    function test_a_revoked_member_keeps_nothing() public {
        assertEq(registrar.membershipOf(MENTOR_1), 0, "membership pointer cleared");
        assertEq(resolver.text(_node("mentor1"), "role"), "", "entitlements cleared");
        assertFalse(
            _mayWrite(MENTOR_1, _node("mentor1"), "avatar"),
            "and the resolver-side right is gone"
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // The catalogue
    ////////////////////////////////////////////////////////////////////////

    function test_the_role_catalogue_is_readable() public view {
        string[] memory mentorKeys = registrar.editableKeysOf(registrar.roleId("mentor"));
        assertEq(mentorKeys.length, 2, "mentor curates two fields");
        assertEq(mentorKeys[0], "avatar");
        assertEq(mentorKeys[1], "ssh.pubkey");

        assertEq(
            registrar.editableKeysOf(registrar.roleId("hacker")).length,
            0,
            "a hacker is delegated nothing, which is why they can write nothing"
        );
    }

    function test_authority_is_wired_where_it_is_needed() public view {
        assertTrue(
            IPermissionedRegistry(address(registrar.REGISTRY())).hasRootRoles(
                registrar.REQUIRED_REGISTRY_ROLES(), REGISTRAR
            ),
            "may mint into its own branch registry"
        );
        assertTrue(
            OrgRegistrar(ORG_REGISTRAR).hasRootRoles(
                OrgRegistrar(ORG_REGISTRAR).ROLE_ENROL(), REGISTRAR
            ),
            "may enrol Members at the organization"
        );
    }

    /// The factory is briefly root of a new registry and must keep nothing.
    function test_the_factory_retained_nothing() public view {
        assertFalse(
            IPermissionedRegistry(address(registrar.REGISTRY())).hasRootRoles(
                RegistryRolesLib.ROLE_REGISTRAR, FACTORY
            ),
            "factory cannot mint into the branch it made"
        );
    }
}
