"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { PageHeader } from "@/components/console/PageHeader";

/**
 * Sign in to the console.
 *
 * The gate in `middleware.ts` fronts two credentials the browser must never hold: the
 * organization's signing key, which every ENS write is signed with, and the enforcer's admin
 * token, which can mint more admin tokens. Neither can be shipped to the client, so the browser
 * proves itself once here and gets an httpOnly cookie it cannot read.
 */
export default function SignInPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/console/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `sign-in failed (${res.status})`);
      router.replace("/console");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Console" title="Sign in" />
      <div className="px-4 py-8 sm:px-6">
        <Panel as="section" className="max-w-[460px]">
          <form onSubmit={submit} className="space-y-4 px-5 py-6">
            <p className="max-w-[46ch] text-sm leading-relaxed text-ink-muted">
              The console signs transactions with the organization&rsquo;s key and holds the
              enforcer&rsquo;s admin token. Paste the console token to unlock it for this browser.
            </p>

            <label className="block">
              <span className="label">Console token</span>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="CONSOLE_TOKEN"
                className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink placeholder:text-ink-faint"
              />
            </label>

            {error ? (
              <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
                {error}
              </p>
            ) : null}

            <Button variant="solid" disabled={!token.trim() || busy}>
              {busy ? "Checking…" : "Unlock the console"}
            </Button>
          </form>
        </Panel>
      </div>
    </>
  );
}
