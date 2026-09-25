/**
 * The deployed ENSCA branch on Sepolia.
 *
 * Mirrors contracts/deployments/sepolia.json. Three registries, one per level of the domain
 * model: the organization holds branches, a branch holds memberships.
 */

export const SEPOLIA_CHAIN_ID = 11155111;

export const RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

export const DEPLOYMENT = {
  organization: "ethglobal2.eth",
  branch: "tokyo.ethglobal2.eth",
  branchLabel: "tokyo",

  orgRegistry: "0xEb716b3fB749f357be2B74a10647675D11a94517",
  branchRegistry: "0x306DE2Ec8c8B5FE668d31be152b6436481448660",
  branchRegistrar: "0xb0487c88Eaea357aDa85540FB1E8bEfAD2868D52",
  resolver: "0x9D8f1376aED12F6F7Ba041285Cce833AcED13092",

  /** ENSv2 Sepolia beta. */
  ethRegistry: "0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E",
  universalResolver: "0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3",

  /** Block the branch registrar was deployed in — the floor for log queries. */
  deployedAtBlock: 11781600n,
} as const;

/** Registrar role bitmaps, matching BranchRegistrar's EAC nybble layout. */
export const REGISTRAR_ROLES = {
  onboard: 1n << 0n,
  promote: 1n << 4n,
  revoke: 1n << 8n,
} as const;

/** BranchRegistrar.Role — ordinal 0 is None, so an unset record denies by default. */
export const ROLE_NAMES = ["none", "hacker", "volunteer", "mentor", "partner", "organizer"] as const;
export type OnChainRole = (typeof ROLE_NAMES)[number];

export function explorer(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}
