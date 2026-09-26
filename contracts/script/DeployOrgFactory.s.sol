// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {OrgFactory} from "../src/OrgFactory.sol";
import {
    BranchFactoryDeployer,
    OrgRegistrarDeployer,
    OrgRegistryDeployer,
    OrgResolverDeployer
} from "../src/OrgDeployers.sol";
import {BranchRegistrarDeployer, BranchRegistryDeployer} from "../src/BranchDeployers.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {SepoliaENSv2} from "./SepoliaENSv2.sol";
import {PermissionedResolver} from "@ens-v2/resolver/PermissionedResolver.sol";

/// @notice Deploy the one factory anybody can use to turn a `.eth` name into an organization.
///
/// @dev Unlike every other script here, this is deployed once and shared: it holds no privilege
///      and keeps nothing, so a single instance serves every organization. It is the piece that
///      makes the product multi-tenant rather than a console pointed at one hardcoded name.
///
///   forge script script/DeployOrgFactory.s.sol:DeployOrgFactory \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
contract DeployOrgFactory is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);

        // Our own resolver implementation, deployed from source.
        //
        // The address ENSv2 publishes as `PERMISSIONED_RESOLVER_IMPL` on Sepolia contains no
        // `initialize` selector at all — a proxy pointed at it reverts `FailedCall` on
        // construction. That is the same docs-versus-deployment divergence that bit
        // `UserRegistryImpl` earlier in this project, so we deploy the implementation we
        // actually compile against and pin every organization's resolver proxy to it.
        PermissionedResolver resolverImpl = new PermissionedResolver(me);
        console.log("resolverImpl:", address(resolverImpl));

        OrgFactory factory = new OrgFactory(
            IPermissionedRegistry(SepoliaENSv2.ETH_REGISTRY),
            ILabelStore(SepoliaENSv2.LABEL_STORE),
            address(resolverImpl),
            new OrgRegistryDeployer(),
            new OrgRegistrarDeployer(),
            new OrgResolverDeployer(),
            new BranchFactoryDeployer(),
            new BranchRegistryDeployer(),
            new BranchRegistrarDeployer()
        );

        vm.stopBroadcast();
        console.log("orgFactory:", address(factory));
    }
}
