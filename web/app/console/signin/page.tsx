"use client";

import { Suspense } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { PageHeader } from "@/components/console/PageHeader";
import { useConsoleSession } from "@/lib/hooks/useConsoleSession";
import { useOrg } from "@/lib/hooks/useOrg";
import { withOrg } from "@/lib/hooks/useOrg";

/**
 * Proving ownership used to be a page you were sent to and had to find your way back from. It is
 * a gate now — `ConsoleGate` asks for the signature in place, before any of the console is drawn
 * — so by the time this route renders, the answer is already yes.
 *
 * The route stays because things link to it, and because "am I proved, and as whom" is a fair
 * question to be able to ask directly.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <Proved />
    </Suspense>
  );
}

function Proved() {
  const router = useRouter();
  const org = useOrg();
  const { session, signOut } = useConsoleSession();

  return (
    <>
      <PageHeader eyebrow="Console" title="Ownership" />
      <div className="px-4 py-8 sm:px-6">
        <Panel as="section" className="max-w-[500px]">
          <div className="space-y-5 px-5 py-6">
            {session ? (
              <>
                <p className="text-sm text-ink">
                  This browser has proved it owns{" "}
                  <span className="font-mono">{session.org}.eth</span>.
                </p>
                <p className="break-all font-mono text-[0.6875rem] text-ink-muted">
                  {session.address}
                </p>
                <p className="max-w-[52ch] text-xs leading-relaxed text-ink-muted">
                  The proof is for that one name and that one wallet. Switching either puts the
                  console back at the signature screen, which is the point — it is not a login.
                </p>
                <div className="flex flex-wrap gap-2">
                  <ButtonLink href={withOrg("/console", session.org)} variant="solid">
                    Open the console
                  </ButtonLink>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      await signOut();
                      router.replace(withOrg("/console", org));
                    }}
                  >
                    Sign out
                  </Button>
                </div>
              </>
            ) : (
              // Reaching this page means the gate let it through, which means there was a
              // session a moment ago. Signing out from here is the way it goes missing.
              <p className="text-sm text-ink-muted">Signed out.</p>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
