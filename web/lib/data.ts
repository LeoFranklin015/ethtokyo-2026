/**
 * Domain model types. All fixture arrays removed — replaced by live API hooks.
 * Static policy config (ROLES, ORG, ENFORCEMENT) lives in lib/config.ts.
 */

export type RoleName = "hacker" | "volunteer" | "mentor" | "partner" | "organizer";
export type GroupName = "hacker" | "staff" | "mentor" | "partner";

export type Branch = {
  label: string;
  ens: string;
  venue: string;
  window: string;
  status: "open" | "scheduled" | "archived";
  members: number;
  online: number;
};

export type Role = {
  name: RoleName;
  group: string;
  vlan: number;
  rate: number;
  ceil: number;
  permissions: string[];
  bitmap: string;
  summary: string;
};

export type Group = {
  // From API
  id: string;
  name: string;
  network_tier: string;
  member_count: number;
  active_session_count: number;
  // Derived locally
  vlan: number;
  pool: number;
  used: number;
  devices: number;
};

export type Membership = {
  label: string;       // ens_name prefix (before first dot) or username
  role: RoleName;      // derived from network_tier
  address: string;     // wallet_address or ""
  devices: number;     // count of active sessions for this user
  bytes_out: number;   // cumulative from active session
  online: boolean;
  onboarded: string;   // formatted logged_in_at
};

export type Sample = { t: string; mbps: number; admitted: number };
