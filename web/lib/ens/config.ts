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
  /** The only value that really has to be configured — everything else hangs off it. */
  organization: "ethglobal2.eth",

  orgRegistry: "0xEb716b3fB749f357be2B74a10647675D11a94517",
  orgRegistrar: "0xA0F10DFd7022eBa1114ECe9C16149841a023Ecd7",
  resolver: "0x9D8f1376aED12F6F7Ba041285Cce833AcED13092",

  /**
   * Fallback branch, used only when the indexer is unreachable.
   *
   * Branches are normally discovered from ENS — a branch is a name with a subregistry, and it
   * publishes its registrar as an `ensca.registrar` text record. These constants exist so the
   * direct-chain path still has something to read; they are not the source of truth, and adding a
   * branch does not require touching them.
   */
  branch: "tokyo.ethglobal2.eth",
  branchLabel: "tokyo",
  branchRegistry: "0x306DE2Ec8c8B5FE668d31be152b6436481448660",
  branchRegistrar: "0xA1e540738e89430598f34f279ce39E3009CBfAB6",

  universalResolver: "0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3",

  /** Floor for log queries — the block the V2 registrar was deployed in. */
  fromBlock: 11782000n,
} as const;

export const ENTITLEMENT_KEYS = ["role", "wifi.group", "wifi.rate", "wifi.ceil"] as const;

export function explorer(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}
