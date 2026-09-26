"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseUnits, type Address, type Hex } from "viem";
import { erc20Abi, ethRegistrarAbi } from "@/lib/ens/abis";
import { ENS } from "@/lib/ens/config";

/**
 * Buying an organization name, from the visitor's own wallet.
 *
 * This runs entirely client-side and deliberately so. Registration used to go through the
 * server, which signed with the organization's key and paid from the organization's USDC — so
 * it had to sit behind the console token, and the very first thing a newcomer tried to do was
 * refused. Worse, the name ended up bought with somebody else's money.
 *
 * An organization is a name somebody owns. Whoever is claiming it should pay for it and hold
 * it, which makes the question of authorisation disappear: there is nothing to protect, because
 * nothing of ours is being spent.
 *
 * The registrar uses commit/reveal so a watcher cannot front-run a name out from under you:
 * commit a hash, wait out `MIN_COMMITMENT_AGE`, then reveal. The commitment covers every
 * argument, so the reveal must repeat them byte for byte — including the secret, which is why
 * it is persisted rather than held only in React state.
 */

const ONE_YEAR = 31_536_000n;
const NO_SUBREGISTRY = "0x0000000000000000000000000000000000000000" as const;
const NO_REFERRER = `0x${"0".repeat(64)}` as const;

export type RegistrationPhase =
  | "idle"
  | "needs-funds"
  | "approving"
  | "committing"
  | "waiting"
  | "registering"
  | "done"
  | "error";

type Pending = { label: string; secret: Hex; owner: Address; committedAt: number };

const STORAGE_KEY = "ensca.pending-commitment";

/** A commitment survives a refresh, because losing it means waiting the window out again. */
function loadPending(): Pending | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

function savePending(p: Pending | null) {
  try {
    if (p) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A browser refusing storage is survivable: the flow still works within one page view.
  }
}

function randomSecret(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

export function useOrgRegistration() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<RegistrationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [balance, setBalance] = useState<bigint | null>(null);
  // Lazy initialiser rather than an effect: there is nothing to wait for, and setting state
  // synchronously inside an effect makes the first paint show "no pending claim" before
  // correcting itself.
  const [pending, setPending] = useState<Pending | null>(() => loadPending());

  useEffect(() => {
    if (phase !== "waiting" || countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  const refreshBalance = useCallback(async () => {
    if (!address || !publicClient) return;
    const held = await publicClient.readContract({
      address: ENS.paymentToken as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
    setBalance(held as bigint);
  }, [address, publicClient]);

  useEffect(() => {
    // Deferred by a microtask so the state lands in its own render pass.
    let live = true;
    void Promise.resolve().then(() => {
      if (live) void refreshBalance();
    });
    return () => {
      live = false;
    };
  }, [refreshBalance]);

  /**
   * Sepolia's payment token is a mock with an open `mint`. Anyone can top themselves up, which
   * is the only reason a stranger can try this product at all — so the console offers it rather
   * than leaving people to go hunting for a faucet.
   */
  const mintTestFunds = useCallback(async () => {
    if (!address) return;
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: ENS.paymentToken as Address,
        abi: erc20Abi,
        functionName: "mint",
        args: [address, parseUnits("100", 6)],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      await refreshBalance();
      setPhase("idle");
    } catch (e) {
      setError(readableError(e));
    }
  }, [address, publicClient, refreshBalance, writeContractAsync]);

  const commit = useCallback(
    async (label: string, price: bigint) => {
      if (!address || !publicClient) return;
      setError(null);

      try {
        if (balance !== null && balance < price) {
          setPhase("needs-funds");
          return;
        }

        const allowance = (await publicClient.readContract({
          address: ENS.paymentToken as Address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, ENS.ethRegistrar as Address],
        })) as bigint;

        if (allowance < price) {
          setPhase("approving");
          const hash = await writeContractAsync({
            address: ENS.paymentToken as Address,
            abi: erc20Abi,
            functionName: "approve",
            args: [ENS.ethRegistrar as Address, price],
          });
          await publicClient.waitForTransactionReceipt({ hash });
        }

        const secret = randomSecret();
        const commitment = (await publicClient.readContract({
          address: ENS.ethRegistrar as Address,
          abi: ethRegistrarAbi,
          functionName: "makeCommitment",
          args: [
            label,
            address,
            secret,
            NO_SUBREGISTRY,
            ENS.resolver as Address,
            ONE_YEAR,
            NO_REFERRER,
          ],
        })) as Hex;

        setPhase("committing");
        const hash = await writeContractAsync({
          address: ENS.ethRegistrar as Address,
          abi: ethRegistrarAbi,
          functionName: "commit",
          args: [commitment],
        });
        await publicClient.waitForTransactionReceipt({ hash });

        const minAge = (await publicClient.readContract({
          address: ENS.ethRegistrar as Address,
          abi: ethRegistrarAbi,
          functionName: "MIN_COMMITMENT_AGE",
        })) as bigint;

        const record: Pending = {
          label,
          secret,
          owner: address,
          committedAt: Math.floor(Date.now() / 1000),
        };
        savePending(record);
        setPending(record);
        setCountdown(Number(minAge) + 5);
        setPhase("waiting");
      } catch (e) {
        setPhase("error");
        setError(readableError(e));
      }
    },
    [address, balance, publicClient, writeContractAsync],
  );

  const register = useCallback(async () => {
    if (!address || !publicClient || !pending) return null;
    setError(null);
    setPhase("registering");
    try {
      // Every argument must match the commitment exactly, or the hashes differ and the
      // registrar sees a commitment that was never made.
      const hash = await writeContractAsync({
        address: ENS.ethRegistrar as Address,
        abi: ethRegistrarAbi,
        functionName: "register",
        args: [
          pending.label,
          pending.owner,
          pending.secret,
          NO_SUBREGISTRY,
          ENS.resolver as Address,
          ONE_YEAR,
          ENS.paymentToken as Address,
          NO_REFERRER,
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      savePending(null);
      setPending(null);
      setPhase("done");
      await refreshBalance();
      return `${pending.label}.eth`;
    } catch (e) {
      setPhase("error");
      setError(readableError(e));
      return null;
    }
  }, [address, pending, publicClient, refreshBalance, writeContractAsync]);

  const discardPending = useCallback(() => {
    savePending(null);
    setPending(null);
    setPhase("idle");
  }, []);

  return {
    phase,
    error,
    countdown,
    balance,
    pending,
    commit,
    register,
    mintTestFunds,
    refreshBalance,
    discardPending,
  };
}

/** Wallet errors are long. Keep the first line, which is the part a person can act on. */
function readableError(e: unknown): string {
  if (!(e instanceof Error)) return "something went wrong";
  if (/User rejected|denied transaction/i.test(e.message)) return "You rejected that request.";
  return e.message.split("\n")[0]!.slice(0, 160);
}
