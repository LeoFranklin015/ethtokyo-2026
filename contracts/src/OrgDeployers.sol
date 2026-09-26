// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";

import {BranchFactory} from "./BranchFactory.sol";
import {IBranchRegistrarDeployer, IBranchRegistryDeployer} from "./BranchDeployers.sol";
import {OrgRegistrar} from "./OrgRegistrar.sol";

/// @notice Deployment is delegated so no single contract carries every bytecode it needs.
///
/// @dev An organization is four contracts, and a factory that held all four creation-codes would
///      blow past EIP-170's 24,576-byte limit — the same wall `BranchDeployers` was written for.
///      Each deployer below holds exactly one.
interface IOrgRegistryDeployer {
    function deploy(ILabelStore labelStore, address admin) external returns (address);
}

interface IOrgRegistrarDeployer {
    function deploy(IPermissionedRegistry registry, address resolver, uint64 expiry, address admin)
        external
        returns (address);
}

interface IOrgResolverDeployer {
    function deploy(address implementation, address admin) external returns (address);
}

interface IBranchFactoryDeployer {
    function deploy(
        IPermissionedRegistry orgRegistry,
        OrgRegistrar orgRegistrar,
        ILabelStore labelStore,
        address resolver,
        bytes32 orgNode,
        bytes calldata orgDnsName,
        address admin,
        IBranchRegistryDeployer registryDeployer,
        IBranchRegistrarDeployer registrarDeployer
    ) external returns (address);
}

contract OrgRegistryDeployer is IOrgRegistryDeployer {
    function deploy(ILabelStore labelStore, address admin) external returns (address) {
        return address(new PermissionedRegistry(labelStore, admin, EACBaseRolesLib.ALL_ROLES));
    }
}

contract OrgRegistrarDeployer is IOrgRegistrarDeployer {
    function deploy(IPermissionedRegistry registry, address resolver, uint64 expiry, address admin)
        external
        returns (address)
    {
        return address(new OrgRegistrar(registry, resolver, expiry, admin));
    }
}

/// @notice One resolver per organization, which is the point rather than a detail.
///
/// @dev Sharing a resolver across organizations puts them all in one EAC assignee budget: each
///      branch registrar takes a slot of `ROLE_SET_TEXT` at the shared root, the nybble caps at
///      15, and the sixteenth branch **anywhere** reverts `EACMaxAssignees` forever. We hit that
///      for real. It is also a trust boundary — a registrar with root `ROLE_SET_TEXT` on a shared
///      resolver can write records for names belonging to organizations it has nothing to do with.
///
///      ENS's own guidance is to give each trust boundary its own resolver instance. This deploys
///      a proxy against the canonical implementation, so every organization gets a fresh budget
///      and a wall around its records.
contract OrgResolverDeployer is IOrgResolverDeployer {
    function deploy(address implementation, address admin) external returns (address) {
        bytes memory init = abi.encodeWithSignature(
            "initialize(address,uint256,bytes[])", admin, EACBaseRolesLib.ALL_ROLES, new bytes[](0)
        );
        return address(new ERC1967Proxy(implementation, init));
    }
}

contract BranchFactoryDeployer is IBranchFactoryDeployer {
    function deploy(
        IPermissionedRegistry orgRegistry,
        OrgRegistrar orgRegistrar,
        ILabelStore labelStore,
        address resolver,
        bytes32 orgNode,
        bytes calldata orgDnsName,
        address admin,
        IBranchRegistryDeployer registryDeployer,
        IBranchRegistrarDeployer registrarDeployer
    ) external returns (address) {
        return address(
            new BranchFactory(
                orgRegistry,
                orgRegistrar,
                labelStore,
                resolver,
                orgNode,
                orgDnsName,
                admin,
                registryDeployer,
                registrarDeployer
            )
        );
    }
}
