import "server-only";
import { createPublicClient, http, keccak256, toHex, type Address } from "viem";
import { sepolia } from "viem/chains";
import { branchFactoryAbi, erc20Abi, ethRegistrarAbi, registryAbi } from "./abis";
import { ENS, RPC_BATCH_SIZE, RPC_URL } from "./config";

/**
 * Reads that answer "is this name free, and what does it cost".
 *
 * This is all that remains of what used to be `write.ts`. That module held a server wallet —
 * `ORG_PRIVATE_KEY` — which registered organization names, opened branches, defined groups,
 * onboarded members and revoked them. Every one of those is now signed by the wallet of the
 * person doing it, because the contracts already check whether that wallet is allowed: a server
 * key holding every role replaced a precise on-chain question with a vague one about which
 * server the request reached, and made this host custodian of the whole organization.
 *
 * Nothing here signs anything. There is no key.
 */

const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL, { batch: { batchSize: RPC_BATCH_SIZE, wait: 8 } }) });

export const ONE_YEAR = 31_536_000n;

const labelHash = (label: string) => BigInt(keccak256(toHex(label)));

export type Availability = {
  label: string;
  name: string;
  available: boolean;
  /** Price for one year, in the payment token's smallest unit. */
  price: string;
  priceFormatted: string;
  token: string;
};

/** Is `<label>.eth` free, and what does a year cost? */
export async function checkAvailability(label: string): Promise<Availability> {
  const [available, symbol, decimals] = await Promise.all([
    publicClient.readContract({
      address: ENS.ethRegistrar as Address,
      abi: ethRegistrarAbi,
      functionName: "isAvailable",
      args: [label],
    }),
    publicClient.readContract({
      address: ENS.paymentToken as Address,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    publicClient.readContract({
      address: ENS.paymentToken as Address,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);

  // Pricing a taken name reverts `NameNotAvailable` (0x477707e8), so only ask when it is free.
  if (!available) {
    return {
      label,
      name: `${label}.eth`,
      available: false,
      price: "0",
      priceFormatted: "—",
      token: symbol,
    };
  }

  const price = await publicClient.readContract({
    address: ENS.ethRegistrar as Address,
    abi: ethRegistrarAbi,
    functionName: "getRegisterPrice",
    args: [label, ONE_YEAR, ENS.paymentToken as Address],
  });

  const total = price[0] + price[1];
  const whole = total / 10n ** BigInt(decimals);
  const frac = (total % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").slice(0, 2);

  return {
    label,
    name: `${label}.eth`,
    available,
    price: total.toString(),
    priceFormatted: `${whole}.${frac} ${symbol}`,
    token: symbol,
  };
}

/** Is `label` free inside a branch's own registry? */
export async function labelAvailable(branchRegistry: Address, label: string): Promise<boolean> {
  const status = await publicClient.readContract({
    address: branchRegistry,
    abi: registryAbi,
    functionName: "getStatus",
    args: [labelHash(label)],
  });
  return status === 0;
}

/** Is `label` free as a branch under the organization? */
export async function branchLabelAvailable(label: string): Promise<boolean> {
  return publicClient.readContract({
    address: ENS.branchFactory as Address,
    abi: branchFactoryAbi,
    functionName: "isAvailable",
    args: [label],
  });
}
