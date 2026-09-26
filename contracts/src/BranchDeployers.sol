// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EACBaseRolesLib} from "@ens-v2/access-control/libraries/EACBaseRolesLib.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";

import {BranchRegistrarV2, IBranchResolver} from "./BranchRegistrarV2.sol";
import {OrgRegistrar} from "./OrgRegistrar.sol";

/**
 * Deployers carrying one contract's creation bytecode each.
 *
 * A contract that does `new X(...)` embeds the whole of `X` in its own code. `BranchFactory`
 * creates both a registry (13.6 KB) and a registrar (11.4 KB), which put it at 37.5 KB against
 * EIP-170's 24,576-byte ceiling. Splitting the two `new` expressions into their own contracts
 * keeps each well under the limit and leaves the factory holding only orchestration.
 *
 * Neither deployer is privileged, and neither needs to be: what they return is powerless until
 * somebody is made its root. A stray call by an outsider produces an orphan registry that nothing
 * points at and nobody can mint into.
 */

interface IBranchRegistryDeployer {
    function deploy(ILabelStore labelStore, address root) external returns (address);
}

interface IBranchRegistrarDeployer {
    function deploy(
        IPermissionedRegistry registry,
        IBranchResolver resolver,
        uint64 expiry,
        address admin,
        OrgRegistrar org,
        bytes32 node
    ) external returns (address);
}

contract BranchRegistryDeployer is IBranchRegistryDeployer {
    /// @param root Receives every role on the new registry — the factory, which hands it on.
    function deploy(ILabelStore labelStore, address root) external returns (address) {
        return address(new PermissionedRegistry(labelStore, root, EACBaseRolesLib.ALL_ROLES));
    }
}

contract BranchRegistrarDeployer is IBranchRegistrarDeployer {
    function deploy(
        IPermissionedRegistry registry,
        IBranchResolver resolver,
        uint64 expiry,
        address admin,
        OrgRegistrar org,
        bytes32 node
    ) external returns (address) {
        return address(new BranchRegistrarV2(registry, resolver, expiry, admin, org, node));
    }
}
