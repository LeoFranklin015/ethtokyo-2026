/**
 * Chain-level addresses only.
 *
 * Nothing here names an organization. There used to be one hardcoded — `ethglobal2.eth`, with
 * its registry, registrar, resolver, branch factory and even a fallback branch — and it meant
 * the product had exactly one tenant: every branch list, every group catalogue and every
 * membership query answered for that one name no matter whose organization you were looking at.
 * Somebody who stood up their own saw somebody else's branches.
 *
 * An organization's contracts are now looked up from the `OrgFactory`, keyed by the name its
 * owner registered. See `lib/ens/org.ts`.
 */

export const SEPOLIA_CHAIN_ID = 11155111;

/** Conservative enough for every provider we have measured. See `lib/wagmi.ts`. */
export const RPC_BATCH_SIZE = 40;

export const RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

export const ENS = {
  /**
   * Shared and unprivileged: anyone who owns a `.eth` name turns it into an organization with
   * this, and it keeps nothing, so one instance serves everybody.
   */
  orgFactory: "0x3ED205a5AD7Cc1545AEa8FAE0113DF3026d9a861",

  /** ENSv2 Sepolia beta: where a `.eth` name is bought and where ownership is read. */
  ethRegistrar: "0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca",
  ethRegistry: "0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E",
  paymentToken: "0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e",
  universalResolver: "0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3",
} as const;

/** The entitlement keys the console renders. A group may publish any key it likes. */
export const ENTITLEMENT_KEYS = ["role", "wifi.group", "wifi.rate", "wifi.ceil"] as const;

export function explorer(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}
