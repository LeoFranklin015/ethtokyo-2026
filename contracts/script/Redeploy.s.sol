// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BranchRegistrar} from "../src/BranchRegistrar.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";

/// @notice Swap the branch's registrar for a new build: authorise the new one, disarm the old.
///   forge script script/Redeploy.s.sol:SwapRegistrar --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
contract SwapRegistrar is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        string memory cfg = vm.readFile("deployments/sepolia.json");
        PermissionedRegistry branchRegistry =
            PermissionedRegistry(vm.parseJsonAddress(cfg, ".branchRegistry"));
        address branchResolver = vm.parseJsonAddress(cfg, ".branchResolver");
        address oldRegistrar = vm.parseJsonAddress(cfg, ".registrar");
        uint64 expiry = uint64(vm.parseJsonUint(cfg, ".expiry"));

        vm.startBroadcast(pk);
        BranchRegistrar registrar = new BranchRegistrar(
            IPermissionedRegistry(address(branchRegistry)), branchResolver, expiry, me
        );
        uint256 required = registrar.REQUIRED_REGISTRY_ROLES();
        branchRegistry.grantRootRoles(required, address(registrar));
        branchRegistry.revokeRootRoles(required, oldRegistrar);
        vm.stopBroadcast();

        console.log("old registrar (disarmed):", oldRegistrar);
        console.log("new registrar           :", address(registrar));
    }
}
