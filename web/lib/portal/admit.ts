import "server-only";

/**
 * Ask the branch host to put a verified device on the network.
 *
 * The split is deliberate. Verification needs a chain client and the ENS reader, which live
 * here; admission needs to write an iptables rule, which only the branch host can do. Neither
 * half can do the other's job, so the console proves who someone is and the enforcer opens the
 * door.
 *
 * Before this existed the portal page announced "You are online" after a successful signature
 * check that granted nothing at all — while the live Flask form still admitted anyone who typed
 * a public ENS name. The claim was false and the real door was unlocked.
 */

const PORTAL_URL = process.env.BRANCH_PORTAL_URL;

export async function admit(ip: string, ensName: string): Promise<{ ok: boolean; reason?: string }> {
  if (!PORTAL_URL) {
    return { ok: false, reason: "no branch portal is configured for this console" };
  }
  if (!ip || ip === "unknown") {
    return { ok: false, reason: "could not determine this device's address" };
  }

  try {
    const res = await fetch(`${PORTAL_URL}/internal/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ip, ens_name: ensName }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, reason: body.error ?? `the branch enforcer said ${res.status}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "enforcer unreachable" };
  }
}
