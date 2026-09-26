import "server-only";

/**
 * Write-through mirroring: ENS is the authority, the enforcer is the copy.
 *
 * The enforcer decides admission from its own SQLite. `internal_ens_lookup` reads the on-chain
 * `wifi.group` entitlement, looks that name up in its `groups` table, and **denies the member if
 * there is no row**. So a group that exists only on chain admits nobody, and a member minted only
 * on chain collapses onto the shared `portal-anon` sentinel and shares one quota bucket with
 * every other unmirrored person.
 *
 * Mirroring therefore runs in the same request as the chain write, after the receipt. Three rules
 * hold it together:
 *
 *  1. **The chain write is the authority.** If mirroring fails, the transaction still happened.
 *     Callers report `mirrored: false` rather than pretending the whole thing failed.
 *  2. **Every call is idempotent.** The enforcer's creates return 409 on replay, so each helper
 *     reads first and falls back to a patch — and treats "already exists" as success.
 *  3. **ENS names the group; the enforcer decides what it means.** We never push a bandwidth
 *     number or a tier from chain data. A mirrored group gets a conservative default tier that a
 *     later operator edit is free to change, and we never overwrite it.
 */

const ENFORCER_URL = process.env.ENFORCER_URL;
const ENFORCER_TOKEN = process.env.ENFORCER_TOKEN;

/** The tier a mirrored group starts on. Deliberately the least privileged one the enforcer has. */
const DEFAULT_TIER = "basic";

export type MirrorResult = { mirrored: boolean; reason?: string };

export function mirrorConfigured(): boolean {
  return Boolean(ENFORCER_URL && ENFORCER_TOKEN);
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ENFORCER_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ENFORCER_TOKEN}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

/**
 * Ensure a group exists on the enforcer under the name ENS uses for it.
 *
 * The join key is the group's name, verbatim, because that is what `internal_ens_lookup` matches
 * the `wifi.group` entitlement against.
 */
export async function mirrorGroup(name: string): Promise<MirrorResult> {
  if (!mirrorConfigured()) return { mirrored: false, reason: "enforcer not configured" };
  try {
    const existing = await call("GET", "/admin/groups");
    const groups = (existing.json.groups ?? []) as { name: string }[];
    if (Array.isArray(groups) && groups.some((g) => g.name === name)) {
      return { mirrored: true };
    }

    const created = await call("POST", "/admin/groups", {
      name,
      network_tier: DEFAULT_TIER,
      notes: "mirrored from ENS",
    });
    // 409 means another writer won the race, which is the outcome we wanted anyway.
    if (created.status === 201 || created.status === 409) return { mirrored: true };
    return { mirrored: false, reason: `enforcer said ${created.status}` };
  } catch (error) {
    return { mirrored: false, reason: error instanceof Error ? error.message : "unreachable" };
  }
}

/**
 * Ensure a member exists on the enforcer, in the right group.
 *
 * `username` and `ens_name` are written to the same value on purpose: `internal_ens_lookup` joins
 * on `username` while `/admin/users/by-ens` joins on `ens_name`, and the two paths disagree for
 * any row where they differ.
 */
export async function mirrorMember(input: {
  ensName: string;
  wallet: string;
  group: string;
}): Promise<MirrorResult> {
  if (!mirrorConfigured()) return { mirrored: false, reason: "enforcer not configured" };
  const ensName = input.ensName.toLowerCase();

  try {
    const groups = await call("GET", "/admin/groups");
    const list = (groups.json.groups ?? []) as { id: string; name: string }[];
    const group = Array.isArray(list) ? list.find((g) => g.name === input.group) : undefined;
    if (!group) return { mirrored: false, reason: `group "${input.group}" is not on the enforcer` };

    const found = await call("GET", `/admin/users/by-ens/${encodeURIComponent(ensName)}`);
    if (found.status === 200) {
      const id = found.json.id as string;
      const patched = await call("PATCH", `/admin/users/${id}`, {
        group_id: group.id,
        wallet_address: input.wallet.toLowerCase(),
        disabled: false,
      });
      return patched.status === 200
        ? { mirrored: true }
        : { mirrored: false, reason: `enforcer said ${patched.status}` };
    }

    const created = await call("POST", "/admin/users", {
      username: ensName,
      ens_name: ensName,
      wallet_address: input.wallet.toLowerCase(),
      group_id: group.id,
      // The enforcer requires a password it will never check: this member authenticates by
      // proving control of their name, not by knowing a secret. An unguessable value is the
      // honest way to fill a field the API insists on.
      password: crypto.randomUUID(),
      notes: "mirrored from ENS",
    });
    if (created.status === 201 || created.status === 409) return { mirrored: true };
    return { mirrored: false, reason: `enforcer said ${created.status}` };
  } catch (error) {
    return { mirrored: false, reason: error instanceof Error ? error.message : "unreachable" };
  }
}

/** Disable a member on the enforcer, so an on-chain revocation actually ends their access. */
export async function mirrorRevoke(ensName: string): Promise<MirrorResult> {
  if (!mirrorConfigured()) return { mirrored: false, reason: "enforcer not configured" };
  try {
    const found = await call("GET", `/admin/users/by-ens/${encodeURIComponent(ensName.toLowerCase())}`);
    if (found.status === 404) return { mirrored: true }; // never mirrored; nothing to disable
    if (found.status !== 200) return { mirrored: false, reason: `enforcer said ${found.status}` };

    const id = found.json.id as string;
    await call("PATCH", `/admin/users/${id}`, { disabled: true });
    // Tear down the live session too, or the member keeps the network until it expires.
    await call("POST", `/admin/users/${id}/revoke`);
    return { mirrored: true };
  } catch (error) {
    return { mirrored: false, reason: error instanceof Error ? error.message : "unreachable" };
  }
}
