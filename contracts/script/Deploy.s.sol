// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BranchRegistrar} from "../src/BranchRegistrar.sol";
import {SepoliaENSv2} from "./SepoliaENSv2.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {PermissionedResolver} from "@ens-v2/resolver/PermissionedResolver.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {IETHRegistrar} from "@ens-v2/registrar/interfaces/IETHRegistrar.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Shared config. `BRANCH_LABEL` becomes `<label>.eth`.
abstract contract LifecycleBase is Script {
    string constant BRANCH_LABEL = "ethglobal2";
    uint64 constant DURATION = 365 days;
    /// @dev Never a committed constant: the commitment is public, so a hardcoded secret lets
    ///      anyone reconstruct it and front-run the registration.
    function secret() internal view returns (bytes32) {
        return vm.envBytes32("REGISTRATION_SECRET");
    }

    IPermissionedRegistry ethRegistry = IPermissionedRegistry(SepoliaENSv2.ETH_REGISTRY);
    IETHRegistrar ethRegistrar = IETHRegistrar(SepoliaENSv2.ETH_REGISTRAR);
    IERC20 usdc = IERC20(SepoliaENSv2.MOCK_USDC);

    /// @dev ENS namehash of `<label>.<BRANCH_LABEL>.eth`.
    ///      The resolver keys records by the full namehash. Hashing only the label produces a
    ///      node nothing resolves to — the records write successfully and then read back empty
    ///      through the UniversalResolver.
    function membershipNode(string memory label) internal pure returns (bytes32 node) {
        node = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        node = keccak256(abi.encodePacked(node, keccak256(bytes(BRANCH_LABEL))));
        node = keccak256(abi.encodePacked(node, keccak256(bytes(label))));
    }

    function commitment(address owner) internal view returns (bytes32) {
        return ethRegistrar.makeCommitment(
            BRANCH_LABEL, owner, secret(), IRegistry(address(0)), address(0), DURATION, bytes32(0)
        );
    }
}

/// @notice Step 1 — approve USDC and commit. Wait MIN_COMMITMENT_AGE before step 2.
///   forge script script/Deploy.s.sol:Commit --rpc-url $SEPOLIA_RPC_URL --broadcast
contract Commit is LifecycleBase {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        require(ethRegistrar.isAvailable(BRANCH_LABEL), "label already taken");
        (uint256 base, uint256 premium) = ethRegistrar.getRegisterPrice(BRANCH_LABEL, DURATION, usdc);
        uint256 price = base + premium;
        require(usdc.balanceOf(me) >= price, "insufficient mock USDC");

        vm.startBroadcast(pk);
        usdc.approve(address(ethRegistrar), price);
        ethRegistrar.commit(commitment(me));
        vm.stopBroadcast();

        console.log("committed. price:", price);
        console.log("wait at least MIN_COMMITMENT_AGE (60s on Sepolia) before Deploy");
    }
}

/// @notice Step 2 — register the branch and stand up the whole branch.
///   forge script script/Deploy.s.sol:Deploy --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
contract Deploy is LifecycleBase {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        // 1. The branch name is registered separately (commit/reveal needs a wall-clock
        //    wait between two transactions, which does not belong inside a broadcast).
        uint256 labelHash = uint256(keccak256(bytes(BRANCH_LABEL)));
        require(
            ethRegistry.getStatus(labelHash) == IPermissionedRegistry.Status.REGISTERED,
            "branch name not registered yet"
        );
        uint256 branchResource = ethRegistry.getResource(labelHash);
        require(ethRegistry.getOwner(branchResource) == me, "not the branch owner");
        uint64 branchExpiry = ethRegistry.getExpiry(branchResource);

        vm.startBroadcast(pk);

        // 2. The branch's own registry.
        PermissionedRegistry branchRegistry = new PermissionedRegistry(
            ILabelStore(SepoliaENSv2.LABEL_STORE), me, EACBaseRolesLib.ALL_ROLES
        );

        // 3. Attach it, both ways: forward pointer for resolution, backward for naming.
        ethRegistry.setSubregistry(branchResource, IRegistry(address(branchRegistry)));
        branchRegistry.setParent(IRegistry(address(ethRegistry)), BRANCH_LABEL);

        // 4. A resolver instance the branch controls.
        address resolverImpl = address(new PermissionedResolver(me));
        address branchResolver = address(
            new ERC1967Proxy(
                resolverImpl,
                abi.encodeCall(
                    PermissionedResolver.initialize,
                    (me, EACBaseRolesLib.ALL_ROLES, new bytes[](0))
                )
            )
        );
        ethRegistry.setResolver(branchResource, branchResolver);

        // 5. The registrar, and its authority. No human holds ROLE_REGISTRAR.
        BranchRegistrar registrar =
            new BranchRegistrar(IPermissionedRegistry(address(branchRegistry)), branchResolver, branchExpiry, me);
        branchRegistry.grantRootRoles(registrar.REQUIRED_REGISTRY_ROLES(), address(registrar));

        vm.stopBroadcast();

        console.log("branch        :", BRANCH_LABEL);
        console.log("branchResource:", branchResource);
        console.log("branchRegistry:", address(branchRegistry));
        console.log("branchResolver:", branchResolver);
        console.log("registrar     :", address(registrar));
        console.log("expiry        :", branchExpiry);

        string memory obj = "ensca";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeString(obj, "branch", string.concat(BRANCH_LABEL, ".eth"));
        vm.serializeAddress(obj, "branchRegistry", address(branchRegistry));
        vm.serializeAddress(obj, "branchResolver", branchResolver);
        vm.serializeAddress(obj, "resolverImpl", resolverImpl);
        vm.serializeAddress(obj, "owner", me);
        vm.serializeUint(obj, "expiry", branchExpiry);
        vm.writeJson(vm.serializeAddress(obj, "registrar", address(registrar)), "deployments/sepolia.json");
    }
}

/// @notice Step 3 — onboard a membership and write its entitlements.
///   forge script script/Deploy.s.sol:Onboard --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
contract Onboard is LifecycleBase {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        string memory cfg = vm.readFile("deployments/sepolia.json");
        BranchRegistrar registrar = BranchRegistrar(vm.parseJsonAddress(cfg, ".registrar"));
        PermissionedResolver resolver =
            PermissionedResolver(vm.parseJsonAddress(cfg, ".branchResolver"));

        string memory label = vm.envOr("MEMBER_LABEL", string("leo"));
        address owner = vm.envOr("MEMBER_OWNER", me);

        vm.startBroadcast(pk);
        uint256 resource = registrar.onboard(label, owner, BranchRegistrar.Role.Hacker);

        bytes32 node = membershipNode(label);
        resolver.setText(node, "role", "hacker");
        resolver.setText(node, "wifi.group", "hacker");
        resolver.setText(node, "wifi.rate", "5mbps");
        resolver.setText(node, "wifi.ceil", "20mbps");
        vm.stopBroadcast();

        console.log("membership:", string.concat(label, ".", BRANCH_LABEL, ".eth"));
        console.log("owner     :", owner);
        console.log("resource  :", resource);
    }
}
