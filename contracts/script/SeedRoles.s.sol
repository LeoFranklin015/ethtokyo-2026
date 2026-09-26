// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BranchRegistrarV2} from "../src/BranchRegistrarV2.sol";

/// @notice Define the organization's role catalogue on-chain. Data, not a redeploy.
contract SeedRoles is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        BranchRegistrarV2 r = BranchRegistrarV2(vm.envAddress("REGISTRAR_V2"));

        vm.startBroadcast(pk);

        // hacker — open to any onboarder, edits nothing, 5/20 Mbps.
        BranchRegistrarV2.Entitlement[] memory hacker = new BranchRegistrarV2.Entitlement[](4);
        hacker[0] = BranchRegistrarV2.Entitlement("role", "hacker");
        hacker[1] = BranchRegistrarV2.Entitlement("wifi.group", "hacker");
        hacker[2] = BranchRegistrarV2.Entitlement("wifi.rate", "5mbps");
        hacker[3] = BranchRegistrarV2.Entitlement("wifi.ceil", "20mbps");
        r.defineRole("hacker", 0, false, true, new string[](0), hacker);

        // volunteer — may onboard open roles; may set its own avatar.
        string[] memory volKeys = new string[](1);
        volKeys[0] = "avatar";
        BranchRegistrarV2.Entitlement[] memory vol = new BranchRegistrarV2.Entitlement[](4);
        vol[0] = BranchRegistrarV2.Entitlement("role", "volunteer");
        vol[1] = BranchRegistrarV2.Entitlement("wifi.group", "staff");
        vol[2] = BranchRegistrarV2.Entitlement("wifi.rate", "10mbps");
        vol[3] = BranchRegistrarV2.Entitlement("wifi.ceil", "50mbps");
        r.defineRole("volunteer", 0, true, false, volKeys, vol);

        // mentor — edits its own profile and ssh key, but not its entitlements.
        string[] memory mentorKeys = new string[](2);
        mentorKeys[0] = "avatar";
        mentorKeys[1] = "ssh.pubkey";
        BranchRegistrarV2.Entitlement[] memory mentor = new BranchRegistrarV2.Entitlement[](4);
        mentor[0] = BranchRegistrarV2.Entitlement("role", "mentor");
        mentor[1] = BranchRegistrarV2.Entitlement("wifi.group", "mentor");
        mentor[2] = BranchRegistrarV2.Entitlement("wifi.rate", "20mbps");
        mentor[3] = BranchRegistrarV2.Entitlement("wifi.ceil", "100mbps");
        r.defineRole("mentor", 0, false, false, mentorKeys, mentor);

        vm.stopBroadcast();

        console.log("roles defined: hacker, volunteer, mentor");
    }
}
