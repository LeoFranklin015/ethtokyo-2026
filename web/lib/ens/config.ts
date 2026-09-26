/**
 * The deployed ENSCA contracts on Sepolia. Mirrors contracts/deployments/sepolia.json.
 *
 * Three registries, one per level of the domain model: the organization holds branches, a branch
 * holds memberships, and a person's Member name sits at the organization level.
 */

export const SEPOLIA_CHAIN_ID = 11155111;

export const RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

export const ENS = {
  organization: "ethglobal2.eth",
  branch: "tokyo.ethglobal2.eth",
  branchLabel: "tokyo",

  orgRegistry: "0xEb716b3fB749f357be2B74a10647675D11a94517",
  orgRegistrar: "0xA0F10DFd7022eBa1114ECe9C16149841a023Ecd7",
  branchRegistry: "0x306DE2Ec8c8B5FE668d31be152b6436481448660",
  branchRegistrar: "0xA1e540738e89430598f34f279ce39E3009CBfAB6",
  resolver: "0x9D8f1376aED12F6F7Ba041285Cce833AcED13092",

  universalResolver: "0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3",

  /** Floor for log queries — the block the V2 registrar was deployed in. */
  fromBlock: 11782000n,
} as const;

export const ENTITLEMENT_KEYS = ["role", "wifi.group", "wifi.rate", "wifi.ceil"] as const;

export function explorer(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}
