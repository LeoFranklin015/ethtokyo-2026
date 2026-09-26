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

/**
 * Why admission did not happen, when it did not.
 *
 * `refused` is the enforcer answering "no"; `unreachable` is it not answering at all. Collapsing
 * the two tells a member standing next to a broken daemon that they are not allowed on the
 * network, which is both false and unactionable — one of these is fixed by finding an organizer,
 * the other by somebody restarting a service.
 */
export type AdmissionFailure = "unconfigured" | "no-address" | "refused" | "unreachable";

export type Admission = { ok: boolean; reason?: string; kind?: AdmissionFailure };

export async function admit(ip: string, ensName: string): Promise<Admission> {
  if (!PORTAL_URL) {
    return {
      ok: false,
      kind: "unconfigured",
      reason: "no perimeter portal is configured for this console",
    };
  }
  if (!ip || ip === "unknown") {
    return { ok: false, kind: "no-address", reason: "could not determine this device's address" };
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
    return {
      ok: false,
      kind: "refused",
      reason: body.error ?? `the perimeter enforcer said ${res.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      kind: "unreachable",
      reason: error instanceof Error ? error.message : "enforcer unreachable",
    };
  }
}

/**
 * Is this device already on the network?
 *
 * Asked before the page walks anyone through a badge and a signature, because a captive portal
 * is reopened constantly — by the OS probe, by a tab restore, by someone tapping the notification
 * again — and telling an admitted device to scan its badge again is both wrong and slow.
 *
 * An enforcer that cannot be reached answers `null`, never `false`: not knowing is not the same
 * as knowing they are out, and the flow simply starts from the beginning in that case.
 */
export async function admissionStatus(
  ip: string,
): Promise<{ admitted: boolean; ensName?: string; tier?: string } | null> {
  if (!PORTAL_URL || !ip || ip === "unknown") return null;
  try {
    const res = await fetch(`${PORTAL_URL}/internal/status?ip=${encodeURIComponent(ip)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { admitted?: boolean; ens_name?: string; tier?: string };
    return { admitted: Boolean(body.admitted), ensName: body.ens_name, tier: body.tier };
  } catch {
    return null;
  }
}
