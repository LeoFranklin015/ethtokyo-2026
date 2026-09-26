"use client";

import useSWR from "swr";
import { useAccount, useSignMessage } from "wagmi";

/**
 * Whether this browser has proved it owns an organization.
 *
 * The proof is a signature over a server-issued nonce, checked against the `.eth` registry. It
 * is not a login in the usual sense — there is no account and no password, and the answer can
 * change under you when the name changes hands, which is exactly what should happen.
 */

export type Session = { address: string; org: string; exp: number } | null;

type Payload = {
  session: Session;
  nonce: string;
  issuedAt: string;
  /** Present only when the request named a wallet and an organization. */
  message: string | null;
};

export function useConsoleSession() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const { data, error, isLoading, mutate } = useSWR<Payload>(
    "console-session",
    async () => {
      const res = await fetch("/api/console/session", { cache: "no-store" });
      if (!res.ok) throw new Error("could not read the console session");
      return res.json();
    },
    { revalidateOnFocus: false },
  );

  const session = data?.session ?? null;

  /** Ask the wallet to sign, then post it. Throws with something an operator can read. */
  async function signIn(org: string) {
    if (!address) throw new Error("connect a wallet first");

    // Always take a fresh challenge, worded by the server: the nonce from the last poll may have
    // been spent, and the text has to match byte for byte on both sides.
    const label = org.replace(/\.eth$/, "");
    const fresh = (await fetch(
      `/api/console/session?address=${address}&org=${encodeURIComponent(label)}`,
      { cache: "no-store" },
    ).then((r) => r.json())) as Payload;

    if (!fresh.message) throw new Error("the console could not build a challenge to sign");

    const signature = await signMessageAsync({ message: fresh.message });

    const res = await fetch("/api/console/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address,
        org: label,
        signature,
        issuedAt: fresh.issuedAt,
        nonce: fresh.nonce,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `sign-in failed (${res.status})`);

    await mutate();
  }

  async function signOut() {
    await fetch("/api/console/session", { method: "DELETE" });
    await mutate();
  }

  return { session, signIn, signOut, error, isLoading, reload: mutate };
}
