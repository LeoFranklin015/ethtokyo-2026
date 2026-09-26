"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { keccak256, toHex, type Address } from "viem";
import { registryAbi } from "@/lib/ens/abis";
import { ENS } from "@/lib/ens/config";

/**
 * Finding out whether a `.eth` name is free, and whether it is yours.
 *
 * This deliberately does **not** register anything. Registration is commit/reveal: approve the
 * payment token, publish a commitment, wait out `MIN_COMMITMENT_AGE`, then reveal — three
 * transactions and a timed window, where a refresh at the wrong moment strands a paid-for
 * commitment and a mismatched argument between the two halves fails in a way nobody can read.
 *
 * The ENS app already does all of that, properly, and it is the same Sepolia deployment we are
 * built on. So this looks the name up, and hands people over there to buy it. What we need back
 * is one fact — does this wallet own the name — and that is a single read.
 */

export const ENS_APP_URL = process.env.NEXT_PUBLIC_ENS_APP_URL ?? "https://app.ens.dev";

export type NameStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "invalid"; reason: string }
  | { state: "available"; name: string; priceFormatted: string | null }
  | { state: "yours"; name: string }
  | { state: "taken"; name: string; owner: Address };

/** Where to send somebody to register or manage a name. */
export function ensAppLink(name: string): string {
  return `${ENS_APP_URL}/${name}`;
}

export function useOrgName(label: string) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [status, setStatus] = useState<NameStatus>({ state: "idle" });

  const check = useCallback(
    async (value: string) => {
      const clean = value.trim().toLowerCase();
      if (!clean) {
        setStatus({ state: "idle" });
        return;
      }
      if (!/^[a-z0-9-]{3,32}$/.test(clean) || clean.startsWith("-") || clean.endsWith("-")) {
        setStatus({
          state: "invalid",
          reason: "3–32 characters, lowercase letters, digits and hyphens",
        });
        return;
      }

      setStatus({ state: "checking" });
      try {
        const res = await fetch(`/api/ens/available?label=${encodeURIComponent(clean)}`);
        if (!res.ok) throw new Error("could not reach the registrar");
        const body = (await res.json()) as {
          valid: boolean;
          reason?: string;
          available: boolean;
          priceFormatted?: string;
        };

        if (!body.valid) {
          setStatus({ state: "invalid", reason: body.reason ?? "not a usable name" });
          return;
        }
        if (body.available) {
          setStatus({
            state: "available",
            name: `${clean}.eth`,
            priceFormatted: body.priceFormatted ?? null,
          });
          return;
        }

        // Taken — but possibly by the person asking, which is the case that matters here.
        const owner = (await publicClient!.readContract({
          address: ENS.ethRegistry as Address,
          abi: registryAbi,
          functionName: "getOwner",
          args: [BigInt(keccak256(toHex(clean)))],
        })) as Address;

        if (address && owner.toLowerCase() === address.toLowerCase()) {
          setStatus({ state: "yours", name: `${clean}.eth` });
        } else {
          setStatus({ state: "taken", name: `${clean}.eth`, owner });
        }
      } catch (e) {
        setStatus({
          state: "invalid",
          reason: e instanceof Error ? e.message : "could not check that name",
        });
      }
    },
    [address, publicClient],
  );

  // Debounced, and re-run when the wallet changes — a name that is "taken" becomes "yours" the
  // moment the right wallet connects, and making somebody retype to discover that is unkind.
  useEffect(() => {
    const t = setTimeout(() => void check(label), 350);
    return () => clearTimeout(t);
  }, [label, check]);

  return { status, recheck: () => check(label) };
}
