// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {BranchRegistrar} from "../src/BranchRegistrar.sol";
import {SepoliaENSv2} from "../script/SepoliaENSv2.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {IETHRegistrar} from "@ens-v2/registrar/interfaces/IETHRegistrar.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {PermissionedResolver} from "@ens-v2/resolver/PermissionedResolver.sol";
import {PermissionedResolverLib} from "@ens-v2/resolver/libraries/PermissionedResolverLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice The whole branch lifecycle against live Sepolia ENSv2, as a dry run.
///
/// This is the rehearsal for the real deployment: same addresses, same interfaces, same call
/// sequence. If this passes, the only things the live run adds are real gas and real time.
///
///   forge test --match-path test/Lifecycle.fork.t.sol --fork-url $SEPOLIA_RPC_URL -vv
contract LifecycleForkTest is Test {
    /// @dev A fresh label each run: the rehearsal registers it for real on the fork, and
    ///      `ethglobal2` is now taken on live Sepolia by the actual deployment.
    string internal BRANCH_LABEL;

    IPermissionedRegistry ethRegistry = IPermissionedRegistry(SepoliaENSv2.ETH_REGISTRY);
    IETHRegistrar ethRegistrar = IETHRegistrar(SepoliaENSv2.ETH_REGISTRAR);
    IERC20 usdc = IERC20(SepoliaENSv2.MOCK_USDC);

    address organizer = makeAddr("organizer");
    address volunteer = makeAddr("volunteer");
    address leo = makeAddr("leo");
    address ann = makeAddr("ann");

    function setUp() public {
        vm.skip(block.chainid != 11155111, "requires a Sepolia fork");
        BRANCH_LABEL = string.concat("ensca-rehearsal-", vm.toString(block.number));
    }

    function test_full_branch_lifecycle() public {
        // ── 1. Register the branch name ───────────────────────────────────
        assertTrue(ethRegistrar.isAvailable(BRANCH_LABEL), "branch label must be free");

        uint64 duration = 365 days;
        (uint256 base, uint256 premium) =
            ethRegistrar.getRegisterPrice(BRANCH_LABEL, duration, usdc);
        uint256 price = base + premium;
        console.log("register price (USDC units):", price);

        deal(address(usdc), organizer, price * 2);

        bytes32 secret = keccak256("ensca-dry-run");
        vm.startPrank(organizer);
        usdc.approve(address(ethRegistrar), price);

        bytes32 commitment = ethRegistrar.makeCommitment(
            BRANCH_LABEL, organizer, secret, IRegistry(address(0)), address(0), duration, bytes32(0)
        );
        ethRegistrar.commit(commitment);
        vm.stopPrank();

        // The commit/reveal window is enforced on-chain.
        vm.warp(block.timestamp + 61);

        vm.prank(organizer);
        uint256 branchTokenId = ethRegistrar.register(
            BRANCH_LABEL,
            organizer,
            secret,
            IRegistry(address(0)),
            address(0),
            duration,
            usdc,
            bytes32(0)
        );

        uint256 branchResource = ethRegistry.getResource(branchTokenId);
        assertEq(ethRegistry.getOwner(branchResource), organizer, "organizer owns the branch name");
        assertEq(
            uint8(ethRegistry.getStatus(branchResource)),
            uint8(IPermissionedRegistry.Status.REGISTERED)
        );

        // ── 2. Deploy the branch's own registry ───────────────────────────
        uint256 branchExpiry = ethRegistry.getExpiry(branchResource);

        // A plain PermissionedRegistry, reusing the canonical Sepolia LabelStore. The
        // VerifiableFactory/UserRegistry proxy route is the upgradeable alternative; it is not
        // needed here and its Sepolia proxy reverts on the documented initialize sequence.
        // EAC bitmaps are nybble-packed, so ALL_ROLES is the mask — not type(uint256).max.
        vm.prank(organizer);
        address branchRegistry = address(
            new PermissionedRegistry(
                ILabelStore(SepoliaENSv2.LABEL_STORE), organizer, EACBaseRolesLib.ALL_ROLES
            )
        );
        assertTrue(branchRegistry.code.length > 0, "branch registry deployed");

        // ── 3. Attach it under the branch name ────────────────────────────
        vm.prank(organizer);
        ethRegistry.setSubregistry(branchResource, IRegistry(branchRegistry));
        assertEq(
            address(ethRegistry.getSubregistry(BRANCH_LABEL)),
            branchRegistry,
            "subregistry attached"
        );

        // ── 3b. Record the canonical parent ───────────────────────────────
        // Without this the UniversalHelper cannot walk back up the tree, so
        // findCanonicalName — and every indexer that uses it — cannot name the branch.
        vm.prank(organizer);
        PermissionedRegistry(branchRegistry).setParent(IRegistry(address(ethRegistry)), BRANCH_LABEL);
        (IRegistry parent, string memory parentLabel) = PermissionedRegistry(branchRegistry).getParent();
        assertEq(address(parent), address(ethRegistry), "canonical parent recorded");
        assertEq(parentLabel, BRANCH_LABEL);

        // ── 4. Deploy the branch resolver, then the registrar ─────────────
        // A resolver instance of our own: members hold no roles on it, so a membership
        // holder's setText reverts. That is the "cannot edit your own records" property.
        address resolverImpl = address(new PermissionedResolver(organizer));
        address branchResolver = address(
            new ERC1967Proxy(
                resolverImpl,
                abi.encodeCall(
                    PermissionedResolver.initialize,
                    (organizer, EACBaseRolesLib.ALL_ROLES, new bytes[](0))
                )
            )
        );

        BranchRegistrar registrar = new BranchRegistrar(
            IPermissionedRegistry(branchRegistry), branchResolver, uint64(branchExpiry), organizer
        );

        // ── 5. Authorise it. No human holds ROLE_REGISTRAR. ───────────────
        uint256 required = registrar.REQUIRED_REGISTRY_ROLES();
        vm.prank(organizer);
        IPermissionedRegistry(branchRegistry).grantRootRoles(required, address(registrar));
        assertTrue(
            IPermissionedRegistry(branchRegistry).hasRootRoles(required, address(registrar)),
            "registrar authorised"
        );

        uint256 onboardRole = registrar.ROLE_ONBOARD();
        vm.prank(organizer);
        registrar.grantRootRoles(onboardRole, volunteer);

        // ── 6. Onboard ────────────────────────────────────────────────────
        vm.prank(volunteer);
        uint256 leoResource = registrar.onboard("leo", leo, BranchRegistrar.Role.Hacker);

        IPermissionedRegistry branch = IPermissionedRegistry(branchRegistry);
        assertEq(branch.getOwner(leoResource), leo, "leo.ethglobal2.eth is leo's");
        assertEq(branch.getExpiry(leoResource), branchExpiry, "membership expires with the branch");

        // A hacker owns the name but holds nothing over it.
        assertEq(branch.roles(leoResource, leo), 0, "hacker holds no registry roles");

        // The registrar's whole reason to exist.
        vm.prank(volunteer);
        vm.expectRevert(
            abi.encodeWithSelector(
                BranchRegistrar.CannotGrantRole.selector, volunteer, BranchRegistrar.Role.Organizer
            )
        );
        registrar.onboard("ann", ann, BranchRegistrar.Role.Organizer);

        // ── 6b. Entitlements as text records ──────────────────────────────
        // The full ENS namehash, not just the label: the resolver keys records by namehash, so
        // hashing the label alone writes to a node nothing resolves to.
        bytes32 ethNode = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        bytes32 branchNode = keccak256(abi.encodePacked(ethNode, keccak256(bytes(BRANCH_LABEL))));
        bytes32 leoNode = keccak256(abi.encodePacked(branchNode, keccak256("leo")));

        vm.startPrank(organizer);
        PermissionedResolver(branchResolver).setText(leoNode, "role", "hacker");
        PermissionedResolver(branchResolver).setText(leoNode, "wifi.group", "hacker");
        PermissionedResolver(branchResolver).setText(leoNode, "wifi.rate", "5mbps");
        vm.stopPrank();
        assertEq(PermissionedResolver(branchResolver).text(leoNode, "wifi.group"), "hacker");
        assertEq(PermissionedResolver(branchResolver).text(leoNode, "wifi.rate"), "5mbps");

        // The membership holder owns the name but cannot rewrite its entitlements.
        vm.prank(leo);
        vm.expectRevert();
        PermissionedResolver(branchResolver).setText(leoNode, "wifi.rate", "1000mbps");

        // ── 7. Promote, then revoke ───────────────────────────────────────
        vm.prank(organizer);
        registrar.promote(leoResource, BranchRegistrar.Role.Partner);
        assertEq(
            uint8(registrar.roleOf(leoResource)), uint8(BranchRegistrar.Role.Partner), "promoted"
        );

        vm.prank(organizer);
        registrar.revoke(leoResource);
        assertTrue(registrar.isAvailable("leo"), "label freed after revocation");

        console.log("branch registry:", branchRegistry);
        console.log("registrar:      ", address(registrar));
        console.log("branch resolver:", branchResolver);
    }
}

/// @notice Asserts the live Sepolia deployment of ethglobal2.eth is intact.
///
/// This is the end-to-end regression test for what was actually shipped: the hierarchy, the
/// membership, the role bitmap, and the entitlements read back through the ENS UniversalResolver
/// exactly as any client would read them.
///
///   forge test --match-contract LiveDeploymentTest --fork-url $SEPOLIA_RPC_URL -vv
contract LiveDeploymentTest is Test {
    address constant BRANCH_REGISTRY = 0xEb716b3fB749f357be2B74a10647675D11a94517;
    address constant BRANCH_RESOLVER = 0x9D8f1376aED12F6F7Ba041285Cce833AcED13092;
    address constant REGISTRAR = 0x9D9F2264528Cd1F5c76c1d94aCaC251e9eF4a05A;
    address constant OWNER = 0xE08224B2CfaF4f27E2DC7cB3f6B99AcC68Cf06c0;

    bytes32 constant LEO_NODE = 0x849603a21f59f0fcf34170db77da66501b069223229b77303ea7df0fea86cafd;

    function setUp() public {
        vm.skip(block.chainid != 11155111, "requires a Sepolia fork");
    }

    function test_branch_is_attached_to_ethglobal2() public view {
        IPermissionedRegistry ethRegistry = IPermissionedRegistry(SepoliaENSv2.ETH_REGISTRY);
        assertEq(
            uint8(ethRegistry.getStatus(uint256(keccak256("ethglobal2")))),
            uint8(IPermissionedRegistry.Status.REGISTERED),
            "ethglobal2.eth registered"
        );
        assertEq(
            address(ethRegistry.getSubregistry("ethglobal2")),
            BRANCH_REGISTRY,
            "branch registry attached"
        );

        (IRegistry parent, string memory label) = PermissionedRegistry(BRANCH_REGISTRY).getParent();
        assertEq(address(parent), SepoliaENSv2.ETH_REGISTRY, "canonical parent");
        assertEq(label, "ethglobal2");
    }

    function test_membership_and_its_entitlements() public view {
        IPermissionedRegistry branch = IPermissionedRegistry(BRANCH_REGISTRY);
        uint256 leo = uint256(keccak256("leo"));

        assertEq(
            uint8(branch.getStatus(leo)), uint8(IPermissionedRegistry.Status.REGISTERED), "leo minted"
        );
        assertEq(branch.getOwner(leo), OWNER, "leo owned");
        assertEq(branch.roles(leo, OWNER), 0, "hacker holds no registry roles over its own name");

        BranchRegistrar registrar = BranchRegistrar(REGISTRAR);
        assertTrue(
            branch.hasRootRoles(registrar.REQUIRED_REGISTRY_ROLES(), REGISTRAR),
            "registrar still authorised"
        );
        assertEq(
            uint8(registrar.roleOf(branch.getResource(leo))),
            uint8(BranchRegistrar.Role.Hacker),
            "role recorded"
        );

        PermissionedResolver resolver = PermissionedResolver(BRANCH_RESOLVER);
        assertEq(resolver.text(LEO_NODE, "role"), "hacker");
        assertEq(resolver.text(LEO_NODE, "wifi.group"), "hacker");
        assertEq(resolver.text(LEO_NODE, "wifi.rate"), "5mbps");
        assertEq(resolver.text(LEO_NODE, "wifi.ceil"), "20mbps");
    }
}
