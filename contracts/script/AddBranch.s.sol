// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BranchRegistrarV2, IBranchResolver} from "../src/BranchRegistrarV2.sol";
import {OrgRegistrar} from "../src/OrgRegistrar.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {SepoliaENSv2} from "./SepoliaENSv2.sol";

/// @notice Stand up another branch under the same organization, and publish its registrar on ENS.
///
/// @dev A branch is discoverable from ENS already — it is the name that has a subregistry. Its
///      registrar is not: that is only an EAC role holder, invisible to any indexer. Publishing it
///      as an `ensca.registrar` text record makes the whole topology readable from ENS alone, so a
///      console can find every branch of any organization without hardcoded addresses.
contract AddBranch is Script {
    string constant LABEL = "osaka";
    bytes32 constant BRANCH_NODE = 0xcb93dc254db4ff713d8261ba97870b6ceac90fe3dc7f2885799a1ec724788897;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        string memory cfg = vm.readFile("deployments/sepolia.json");
        address orgRegistry = vm.parseJsonAddress(cfg, ".orgRegistry");
        address orgRegistrar = vm.parseJsonAddress(cfg, ".orgRegistrar");
        address resolver = vm.parseJsonAddress(cfg, ".resolver");
        uint64 expiry = uint64(vm.parseJsonUint(cfg, ".expiry"));

        vm.startBroadcast(pk);

        PermissionedRegistry branchRegistry = new PermissionedRegistry(
            ILabelStore(SepoliaENSv2.LABEL_STORE), me, EACBaseRolesLib.ALL_ROLES
        );
        PermissionedRegistry(orgRegistry).register(
            LABEL, me, IRegistry(address(branchRegistry)), resolver, 0, expiry
        );
        branchRegistry.setParent(IRegistry(orgRegistry), LABEL);

        BranchRegistrarV2 registrar = new BranchRegistrarV2(
            IPermissionedRegistry(address(branchRegistry)),
            IBranchResolver(resolver),
            expiry,
            me,
            OrgRegistrar(orgRegistrar),
            BRANCH_NODE
        );
        branchRegistry.grantRootRoles(registrar.REQUIRED_REGISTRY_ROLES(), address(registrar));
        OrgRegistrar(orgRegistrar).grantRootRoles(
            OrgRegistrar(orgRegistrar).ROLE_ENROL(), address(registrar)
        );
        (bool ok,) = resolver.call(
            abi.encodeWithSignature(
                "grantRootRoles(uint256,address)", uint256(1) << 4, address(registrar)
            )
        );
        require(ok, "resolver ROLE_SET_TEXT grant failed");

        vm.stopBroadcast();

        console.log("branch    :", string.concat(LABEL, ".ethglobal2.eth"));
        console.log("registry  :", address(branchRegistry));
        console.log("registrar :", address(registrar));
    }
}
