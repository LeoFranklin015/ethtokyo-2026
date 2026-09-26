// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Sepolia ENSv2 beta deployment addresses.
/// @dev Source: https://docs.ens.domains/learn/deployments/ — the ENSv2 beta section.
///      These are beta contracts; ENS Labs states the interfaces are not final.
library SepoliaENSv2 {
    uint256 internal constant CHAIN_ID = 11155111;

    address internal constant ETH_REGISTRY = 0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E;
    address internal constant ETH_REGISTRAR = 0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca;
    address internal constant ROOT_REGISTRY = 0x9703DBD26dAB89504490994138cF2c575251a9cE;

    address internal constant USER_REGISTRY_IMPL = 0xA80338aAA8D23831cEa25E858D1774534aBb0263;
    address internal constant VERIFIABLE_FACTORY = 0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C;

    address internal constant PUBLIC_RESOLVER_V2 = 0xd7e590Ad0E92A6aC1d81f4483A9B951D3585a50F;
    address internal constant PERMISSIONED_RESOLVER_IMPL = 0x14F09Fd05d4585759e54844DC9B00147131Cf243;
    address internal constant UNIVERSAL_RESOLVER_V2 = 0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3;

    address internal constant MOCK_USDC = 0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e;
    address internal constant MOCK_DAI = 0x278053aCc97888E63Ec81c80FEC641Bf0Bf19664;

    address internal constant LABEL_STORE = 0x375C082021E677a40eA2AE094D050602dba90992;
}
