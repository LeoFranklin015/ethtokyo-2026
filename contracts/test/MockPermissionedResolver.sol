// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IBranchResolver} from "../src/BranchRegistrarV2.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

/// @notice A stand-in for ENSv2's `PermissionedResolver` that models the part of it we depend on:
///         per-`(name, key)` authorization of `setText`.
///
/// @dev The real resolver scopes `ROLE_SET_TEXT` to `resource(namehash, partHash(key))`, so a
///      grant names both the name and the key. A stub that lets anyone write anything would make
///      every permission test in this suite vacuous — the bug this models is exactly the one that
///      let a member write `wifi.rate` on somebody else's name. Two dimensions, both enforced.
contract MockPermissionedResolver is IBranchResolver {
    mapping(bytes32 node => mapping(string key => string value)) public records;

    /// @dev Root writers (the registrar, the org) may write any node. Mirrors a root-scoped grant.
    mapping(address account => bool) public rootWriter;

    /// @dev The fine-grained half: `authorized[node][keccak(key)][account]`.
    mapping(bytes32 node => mapping(bytes32 partHash => mapping(address account => bool)))
        public authorized;

    error NotAuthorized(address account, bytes32 node, string key);

    function grantRootRoles(uint256, address account) external returns (bool) {
        rootWriter[account] = true;
        return true;
    }

    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool updated)
    {
        // The real resolver requires ROLE_SET_TEXT_ADMIN on resource(node, 0) to call this.
        if (!rootWriter[msg.sender]) revert NotAuthorized(msg.sender, bytes32(0), key);
        bytes32 node = NameCoder.namehash(toName, 0);
        authorized[node][keccak256(bytes(key))][account] = grant;
        return true;
    }

    function setText(bytes32 node, string calldata key, string calldata value) external {
        if (!rootWriter[msg.sender] && !authorized[node][keccak256(bytes(key))][msg.sender]) {
            revert NotAuthorized(msg.sender, node, key);
        }
        records[node][key] = value;
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return records[node][key];
    }

    function mayWrite(bytes32 node, string calldata key, address account)
        external
        view
        returns (bool)
    {
        return rootWriter[account] || authorized[node][keccak256(bytes(key))][account];
    }
}
