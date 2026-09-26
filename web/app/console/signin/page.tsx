"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { PageHeader } from "@/components/console/PageHeader";
import { WalletButton } from "@/components/WalletButton";
import { useConsoleSession } from "@/lib/hooks/useConsoleSession";
import { useOrg, useOwnedOrgs } from "@/lib/hooks/useOrg";

/**
 * Prove you own the organization.
 *
 * There is no console token any more. Operating the enforcer is allowed to exactly the wallet
 * that holds the organization's `.eth` name, which is the same authority the contracts already
 * enforce for every write — so there is one answer to "who is in charge here", not two, and
 * nothing has to be provisioned out of band before somebody can run their own organization.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignIn />
    </Suspense>
  );
}

function SignIn() {
  const router = useRouter();
  const { isConnected, address } = useAccount();
  const org = useOrg();
  const { organizations } = useOwnedOrgs();
  const { session, signIn, signOut } = useConsoleSession();

  const [picked, setPicked] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owned = (organizations ?? []).filter((o) => o.ready === true).map((o) => o.label);
  const target = picked || org || owned[0] || "";

  async function prove() {
    setBusy(true);
    setError(null);
    try {
      await signIn(target);
      router.replace(`/console?org=${target}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Console" title="Prove ownership" />
      <div className="px-4 py-8 sm:px-6">
        <Panel as="section" className="max-w-[500px]">
          <div className="space-y-5 px-5 py-6">
            <p className="max-w-[52ch] text-sm leading-relaxed text-ink-muted">
              Reading an organization needs nothing — it is all public. Changing what its branch
              enforcer does needs a signature from the wallet that holds the name, because that
              wallet is who the chain says runs it.
            </p>

            {session ? (
              <div className="space-y-3">
                <p className="text-sm text-ink">
                  Signed in as{" "}
                  <span className="font-mono">{session.org}.eth</span>
                </p>
                <p className="break-all font-mono text-[0.6875rem] text-ink-muted">
                  {session.address}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="solid" onClick={() => router.push(`/console?org=${session.org}`)}>
                    Open the console
                  </Button>
                  <Button variant="ghost" onClick={() => void signOut()}>
                    Sign out
                  </Button>
                </div>
              </div>
            ) : !isConnected ? (
              <div className="space-y-3">
                <p className="text-sm text-ink">Connect the wallet that owns the name.</p>
                <WalletButton />
              </div>
            ) : (
              <div className="space-y-4">
                {owned.length > 1 ? (
                  <label className="block">
                    <span className="label">Organization</span>
                    <select
                      value={target}
                      onChange={(e) => setPicked(e.target.value)}
                      className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink"
                    >
                      {owned.map((label) => (
                        <option key={label} value={label}>
                          {label}.eth
                        </option>
                      ))}
                    </select>
                  </label>
                ) : target ? (
                  <p className="text-sm text-ink">
                    Signing for <span className="font-mono">{target}.eth</span>.
                  </p>
                ) : (
                  <p className="max-w-[52ch] text-sm leading-relaxed text-ink-muted">
                    This wallet holds no organization. Set one up first, or connect the wallet that
                    owns it.
                  </p>
                )}

                <p className="break-all font-mono text-[0.6875rem] text-ink-muted">{address}</p>

                <Button variant="solid" onClick={prove} disabled={!target || busy}>
                  {busy ? "Waiting for the signature…" : "Sign to prove ownership"}
                </Button>

                <p className="max-w-[52ch] text-xs leading-relaxed text-ink-muted">
                  A plain message, not a transaction. It costs nothing and moves nothing.
                </p>
              </div>
            )}

            {error ? (
              <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
                {error}
              </p>
            ) : null}
          </div>
        </Panel>
      </div>
    </>
  );
}
