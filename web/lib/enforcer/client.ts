/**
 * The branch enforcer's admin API.
 *
 * Identity comes from ENS; everything about what is actually happening on the network — sessions,
 * bytes, group limits — comes from here. Nothing in the console is invented: if the enforcer is
 * unreachable, panels say so rather than showing a plausible number.
 */

const BASE = process.env.ENFORCER_URL ?? "";
const TOKEN = process.env.ENFORCER_TOKEN ?? "";

export type EnforcerStatus = {
  db: string;
  active_sessions: number;
  resources_total: number;
  resources_enabled: number;
};

export type Session = {
  id: string;
  username: string;
  group_name: string | null;
  ip: string;
  network_tier: string | null;
  ens_name: string | null;
  wallet_address: string | null;
  logged_in_at: number;
  logged_out_at: number | null;
  bytes_in: number;
  bytes_out: number;
};

export type Group = {
  id: string;
  name: string;
  network_tier: string | null;
  member_count: number;
  active_session_count: number;
};

/** Null means "could not read the enforcer" — never an empty success. */
async function get<T>(path: string): Promise<T | null> {
  if (!BASE) return null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const enforcerConfigured = () => BASE !== "";

export function getStatus() {
  return get<EnforcerStatus>("/status");
}

export async function getSessions(): Promise<Session[] | null> {
  const data = await get<{ sessions: Session[] }>("/admin/sessions?active=true&limit=200");
  return data?.sessions ?? null;
}

export async function getGroups(): Promise<Group[] | null> {
  const data = await get<{ groups: Group[] }>("/admin/groups");
  return data?.groups ?? null;
}

/** Bytes per group, summed from live sessions. */
export function bytesByGroup(sessions: Session[]) {
  const totals = new Map<string, { bytesIn: number; bytesOut: number; devices: number }>();
  for (const s of sessions) {
    const key = s.group_name ?? "ungrouped";
    const current = totals.get(key) ?? { bytesIn: 0, bytesOut: 0, devices: 0 };
    current.bytesIn += s.bytes_in;
    current.bytesOut += s.bytes_out;
    current.devices += 1;
    totals.set(key, current);
  }
  return [...totals.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.bytesIn + b.bytesOut - (a.bytesIn + a.bytesOut));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}
