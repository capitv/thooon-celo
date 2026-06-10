// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ThooonCheckIn} from "../src/ThooonCheckIn.sol";

/// Usage (Celo Mainnet, chain id 42220):
///   export PRIVATE_KEY=0x...                # deployer EOA, funded with ~0.5 CELO
///   forge script script/Deploy.s.sol \
///     --rpc-url https://forno.celo.org \
///     --broadcast --verify \
///     --verifier sourcify
///
/// Celoscan (Etherscan-compatible) alternative:
///   --verify --etherscan-api-key $CELOSCAN_API_KEY \
///   --verifier-url https://api.celoscan.io/api
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        ThooonCheckIn checkIn = new ThooonCheckIn();
        vm.stopBroadcast();

        console.log("ThooonCheckIn deployed at:", address(checkIn));
    }
}
