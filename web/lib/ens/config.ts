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
  branchFactory: "0x4C96E37b679427d362BDE6dFdF123A10f80caA0B",

  /// Shared and unprivileged: anyone who owns a `.eth` name turns it into an organization with
  /// this. It keeps nothing, so one instance serves everybody.
  orgFactory: "0x3ED205a5AD7Cc1545AEa8FAE0113DF3026d9a861",
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

  /** ENSv2 Sepolia beta: where a `.eth` name is bought. */
  ethRegistrar: "0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca",
  ethRegistry: "0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E",
  paymentToken: "0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e",

  /** Floor for log queries — the block the V2 registrar was deployed in. */
} as const;

export const ENTITLEMENT_KEYS = ["role", "wifi.group", "wifi.rate", "wifi.ceil"] as const;

export function explorer(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}
