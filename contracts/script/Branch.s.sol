// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BranchRegistrar} from "../src/BranchRegistrar.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {SepoliaENSv2} from "./SepoliaENSv2.sol";

/// @notice Add the missing Branch level, so names read `<member>.<branch>.<org>.eth`.
///
/// The first deployment collapsed Organization and Branch into one name: memberships sat directly
/// under `ethglobal2.eth`. The domain model has three levels, and ENSv2 expresses that as a
/// registry per level. This registers `tokyo` in the org registry and gives it a subregistry of
/// its own, which becomes the branch that memberships are minted into.
///
///   forge script script/Branch.s.sol:CreateBranch --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
contract CreateBranch is Script {
    string constant BRANCH = "tokyo";

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        string memory cfg = vm.readFile("deployments/sepolia.json");
        PermissionedRegistry orgRegistry =
            PermissionedRegistry(vm.parseJsonAddress(cfg, ".branchRegistry"));
        address resolver = vm.parseJsonAddress(cfg, ".branchResolver");
        uint64 expiry = uint64(vm.parseJsonUint(cfg, ".expiry"));

        vm.startBroadcast(pk);

        // The branch gets its own registry; root roles stay with the organization.
        PermissionedRegistry branchRegistry = new PermissionedRegistry(
            ILabelStore(SepoliaENSv2.LABEL_STORE), me, EACBaseRolesLib.ALL_ROLES
        );

        // Register the branch name inside the org registry, pointing at that registry.
        orgRegistry.register(
            BRANCH, me, IRegistry(address(branchRegistry)), resolver, 0, expiry
        );

        // Backward pointer, so findCanonicalName can walk up from the branch.
        branchRegistry.setParent(IRegistry(address(orgRegistry)), BRANCH);

        BranchRegistrar registrar = new BranchRegistrar(
            IPermissionedRegistry(address(branchRegistry)), resolver, expiry, me
        );
        branchRegistry.grantRootRoles(registrar.REQUIRED_REGISTRY_ROLES(), address(registrar));

        vm.stopBroadcast();

        console.log("branch name    :", string.concat(BRANCH, ".ethglobal2.eth"));
        console.log("branchRegistry :", address(branchRegistry));
        console.log("branchRegistrar:", address(registrar));
    }
}
