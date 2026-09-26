import "server-only";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  namehash,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  branchFactoryAbi,
  erc20Abi,
  ethRegistrarAbi,
  registrarWriteAbi,
  registryAbi,
  resolverAbi,
} from "./abis";
import { ENS, RPC_URL } from "./config";

/**
 * Transactions the console sends on behalf of the organization.
 *
 * These are administrative actions taken by whoever holds the organization's name — buying it,
 * opening a branch, defining a group, onboarding someone — so the console signs them with the
 * organization's key. A member's *own* actions are never signed here: those are proved by the
 * member's wallet, which is the whole point of the identity model.
 *
 * `ORG_PRIVATE_KEY` is read from the environment and never leaves the server.
 */

const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

const labelHash = (label: string) => BigInt(keccak256(toHex(label)));

export const ONE_YEAR = 31_536_000n;

/** Shared between commit and reveal — the commitment hash covers both. */
const NO_SUBREGISTRY = "0x0000000000000000000000000000000000000000" as const;
const NO_REFERRER =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function signerConfigured(): boolean {
  return Boolean(process.env.ORG_PRIVATE_KEY);
}

function wallet() {
  const key = process.env.ORG_PRIVATE_KEY;
  if (!key) throw new Error("ORG_PRIVATE_KEY is not set — the console cannot sign");
  const account = privateKeyToAccount(
    (key.startsWith("0x") ? key : `0x${key}`) as Hex,
  );
  return {
    account,
    client: createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) }),
  };
}

export function signerAddress(): Address | null {
  try {
    return wallet().account.address;
  } catch {
    return null;
  }
}

async function send(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return hash;
}

////////////////////////////////////////////////////////////////////////
// Organization — buying the `.eth` name
////////////////////////////////////////////////////////////////////////

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

/** A secret tied to this label, so the reveal can reconstruct the commitment. */
function secretFor(label: string): Hex {
  const salt = process.env.ORG_PRIVATE_KEY ?? "ensca";
  return keccak256(toHex(`ensca.commit.${label}.${salt.slice(-8)}`));
}

export type CommitResult = { commitment: Hex; readyInSeconds: number; alreadyCommitted: boolean };

/**
 * Step one of buying a name: approve payment and publish a commitment.
 *
 * ENS requires a delay between committing and registering so that watching the mempool does not
 * let someone front-run the name out from under you.
 */
export async function commitOrg(label: string): Promise<CommitResult> {
  const { account, client } = wallet();
  const secret = secretFor(label);

  const commitment = await publicClient.readContract({
    address: ENS.ethRegistrar as Address,
    abi: ethRegistrarAbi,
    functionName: "makeCommitment",
    args: [
      label,
      account.address,
      secret,
      NO_SUBREGISTRY,
      ENS.resolver as Address, // must match `registerOrg` exactly, or the hashes differ
      ONE_YEAR,
      NO_REFERRER,
    ],
  });

  const [existingAt, minAge] = await Promise.all([
    publicClient.readContract({
      address: ENS.ethRegistrar as Address,
      abi: ethRegistrarAbi,
      functionName: "commitmentAt",
      args: [commitment],
    }),
    publicClient.readContract({
      address: ENS.ethRegistrar as Address,
      abi: ethRegistrarAbi,
      functionName: "MIN_COMMITMENT_AGE",
    }),
  ]);

  if (existingAt > 0n) {
    const elapsed = BigInt(Math.floor(Date.now() / 1000)) - existingAt;
    return {
      commitment,
      readyInSeconds: Number(minAge > elapsed ? minAge - elapsed : 0n),
      alreadyCommitted: true,
    };
  }

  const { price } = await checkAvailability(label);
  const allowance = await publicClient.readContract({
    address: ENS.paymentToken as Address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, ENS.ethRegistrar as Address],
  });
  if (allowance < BigInt(price)) {
    await send(
      await client.writeContract({
        address: ENS.paymentToken as Address,
        abi: erc20Abi,
        functionName: "approve",
        args: [ENS.ethRegistrar as Address, BigInt(price) * 2n],
      }),
    );
  }

  await send(
    await client.writeContract({
      address: ENS.ethRegistrar as Address,
      abi: ethRegistrarAbi,
      functionName: "commit",
      args: [commitment],
    }),
  );

  return { commitment, readyInSeconds: Number(minAge), alreadyCommitted: false };
}

/** Step two: reveal the commitment and take the name. */
export async function registerOrg(label: string): Promise<{ txHash: Hex; name: string }> {
  const { account, client } = wallet();

  const txHash = await send(
    await client.writeContract({
      address: ENS.ethRegistrar as Address,
      abi: ethRegistrarAbi,
      functionName: "register",
      args: [
        label,
        account.address,
        secretFor(label),
        NO_SUBREGISTRY,
        ENS.resolver as Address,
        ONE_YEAR,
        ENS.paymentToken as Address,
        NO_REFERRER,
      ],
    }),
  );

  return { txHash, name: `${label}.eth` };
}

////////////////////////////////////////////////////////////////////////
// Groups — categories of people, not names
////////////////////////////////////////////////////////////////////////

export type GroupInput = {
  branchRegistrar: Address;
  name: string;
  /** May onboard people into groups that are open. */
  canOnboard: boolean;
  /** Any onboarder may assign this group, rather than only named delegates. */
  openToOnboarders: boolean;
  /** Text keys a member of this group may edit on their own name. */
  editableKeys: string[];
  /** Records written to every membership in this group. */
  entitlements: { key: string; value: string }[];
};

/**
 * Define a group.
 *
 * A group mints nothing: it is a category stored in the branch registrar, which onboarding then
 * assigns to a person. Redefining one changes what its existing members may do, with no per-member
 * migration.
 */
export async function defineGroup(input: GroupInput): Promise<Hex> {
  const { client } = wallet();
  return send(
    await client.writeContract({
      address: input.branchRegistrar,
      abi: registrarWriteAbi,
      functionName: "defineRole",
      args: [
        input.name,
        0n,
        input.canOnboard,
        input.openToOnboarders,
        input.editableKeys,
        input.entitlements,
      ],
    }),
  );
}

////////////////////////////////////////////////////////////////////////
// Onboarding
////////////////////////////////////////////////////////////////////////

export type OnboardInput = {
  branchRegistrar: Address;
  label: string;
  owner: Address;
  group: string;
  /** Organization-wide label. Defaults to the membership label on a first visit. */
  memberLabel?: string;
};

export async function onboardMember(input: OnboardInput): Promise<Hex> {
  const { client } = wallet();
  const roleId = await publicClient.readContract({
    address: input.branchRegistrar,
    abi: registrarWriteAbi,
    functionName: "roleId",
    args: [input.group],
  });

  return send(
    await client.writeContract({
      address: input.branchRegistrar,
      abi: registrarWriteAbi,
      functionName: "onboard",
      args: [input.label, input.owner, roleId, input.memberLabel ?? input.label],
    }),
  );
}

/** Is this membership label free in the branch? */
export async function labelAvailable(
  branchRegistry: Address,
  label: string,
): Promise<boolean> {
  const status = await publicClient.readContract({
    address: branchRegistry,
    abi: registryAbi,
    functionName: "getStatus",
    args: [labelHash(label)],
  });
  return status === 0;
}

export { namehash, resolverAbi };

////////////////////////////////////////////////////////////////////////
// Branches
////////////////////////////////////////////////////////////////////////

export type BranchInput = {
  label: string;
  /** Absolute unix seconds the branch closes at. */
  expiry: number;
  owner?: Address;
};

/**
 * Open a branch.
 *
 * One transaction: the factory deploys the branch's registry and registrar, points the
 * organization at it, sets the canonical parent back, grants the registrar its authority in three
 * places, publishes the registrar for discovery, hands the branch to its owner and revokes itself.
 * Doing it atomically is what stops a half-built branch existing at all.
 */
export async function createBranch(input: BranchInput): Promise<{ txHash: Hex; label: string }> {
  const { account, client } = wallet();
  const txHash = await send(
    await client.writeContract({
      address: ENS.branchFactory as Address,
      abi: branchFactoryAbi,
      functionName: "createBranch",
      args: [input.label, BigInt(input.expiry), input.owner ?? account.address],
    }),
  );
  return { txHash, label: input.label };
}

/** Is this branch label free under the organization? */
export async function branchLabelAvailable(label: string): Promise<boolean> {
  return publicClient.readContract({
    address: ENS.branchFactory as Address,
    abi: branchFactoryAbi,
    functionName: "isAvailable",
    args: [label],
  });
}
