// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BranchFactory} from "../src/BranchFactory.sol";
import {BranchRegistrarDeployer, BranchRegistryDeployer} from "../src/BranchDeployers.sol";
import {OrgRegistrar} from "../src/OrgRegistrar.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {SepoliaENSv2} from "./SepoliaENSv2.sol";

/// @notice Deploy the factory and make the one-time grants it needs.
///   forge script script/DeployFactory.s.sol:DeployFactory --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
contract DeployFactory is Script {
    bytes32 constant ORG_NODE = 0x291def960cdeed286467d6beeaad1ab15faeb706a2dcd0126a3a6a22ef3e3aef;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        string memory cfg = vm.readFile("deployments/sepolia.json");
        address orgRegistry = vm.parseJsonAddress(cfg, ".orgRegistry");
        address orgRegistrar = vm.parseJsonAddress(cfg, ".orgRegistrar");
        address resolver = vm.parseJsonAddress(cfg, ".resolver");

        vm.startBroadcast(pk);

        BranchFactory factory = new BranchFactory(
            IPermissionedRegistry(orgRegistry),
            OrgRegistrar(orgRegistrar),
            ILabelStore(SepoliaENSv2.LABEL_STORE),
            resolver,
            ORG_NODE,
            me,
            new BranchRegistryDeployer(),
            new BranchRegistrarDeployer()
        );

        // The grants are read off the factory, so setup cannot drift from what it needs.
        PermissionedRegistry(orgRegistry).grantRootRoles(
            factory.requiredOrgRegistryRoles(), address(factory)
        );
        OrgRegistrar(orgRegistrar).grantRootRoles(
            factory.requiredOrgRegistrarRoles(), address(factory)
        );
        (bool ok,) = resolver.call(
            abi.encodeWithSignature(
                "grantRootRoles(uint256,address)", factory.requiredResolverRoles(), address(factory)
            )
        );
        require(ok, "resolver grant failed");

        vm.stopBroadcast();

        console.log("branchFactory:", address(factory));
        console.log("orgNode      :", vm.toString(ORG_NODE));
    }
}
