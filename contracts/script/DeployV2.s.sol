// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BranchRegistrarV2, IBranchResolver} from "../src/BranchRegistrarV2.sol";
import {OrgRegistrar} from "../src/OrgRegistrar.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";

/// @notice Deploy the completed ENS layer onto the live branch and seed the role catalogue.
///   forge script script/DeployV2.s.sol:DeployV2 --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
contract DeployV2 is Script {
    /// namehash("tokyo.ethglobal2.eth")
    bytes32 constant BRANCH_NODE =
        0x732fdef4e1b816694e7e4c9282554901f9d5c61a4636bbe8e6d5ffd322af4c16;

    /// @dev DNS wire format of the organization: \x0aethglobal2\x03eth\x00
    bytes internal constant ORG_DNS_NAME = hex"0a657468676c6f62616c320365746800";
    string constant BRANCH_LABEL = "tokyo";

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        string memory cfg = vm.readFile("deployments/sepolia.json");
        address orgRegistry = vm.parseJsonAddress(cfg, ".orgRegistry");
        address branchRegistry = vm.parseJsonAddress(cfg, ".branchRegistry");
        address resolver = vm.parseJsonAddress(cfg, ".resolver");
        uint64 expiry = uint64(vm.parseJsonUint(cfg, ".expiry"));
        bytes32 branchNode = vm.envOr("BRANCH_NODE", BRANCH_NODE);
        string memory branchLabel = vm.envOr("BRANCH_LABEL", string(BRANCH_LABEL));

        vm.startBroadcast(pk);

        OrgRegistrar org = new OrgRegistrar(
            IPermissionedRegistry(orgRegistry), resolver, expiry, me
        );
        PermissionedRegistry(orgRegistry).grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW, address(org)
        );

        BranchRegistrarV2 registrar = new BranchRegistrarV2(
            IPermissionedRegistry(branchRegistry),
            IBranchResolver(resolver),
            expiry,
            me,
            org,
            branchNode,
            abi.encodePacked(uint8(bytes(branchLabel).length), branchLabel, ORG_DNS_NAME)
        );
        org.grantRootRoles(org.ROLE_ENROL(), address(registrar));
        PermissionedRegistry(branchRegistry).grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW
                | RegistryRolesLib.ROLE_UNREGISTER | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN
                | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN,
            address(registrar)
        );

        // The registrar writes entitlement records at onboarding, so it needs the resolver's
        // ROLE_SET_TEXT. Without it every onboard reverts EACUnauthorizedAccountRoles.
        (bool ok,) = resolver.call(
            abi.encodeWithSignature("grantRootRoles(uint256,address)", uint256(1) << 4, address(registrar))
        );
        require(ok, "grant ROLE_SET_TEXT on resolver failed");

        vm.stopBroadcast();

        console.log("orgRegistrar    :", address(org));
        console.log("branchRegistrarV2:", address(registrar));
        console.log("branchNode      :", vm.toString(branchNode));
    }
}
