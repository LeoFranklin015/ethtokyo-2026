/**
 * Demo fixtures, shaped exactly like the domain model in docs/00-domain-model.md
 * and the entitlements in docs/13-ens-design.md §3.1. Replace with reads from
 * the indexer and the branch enforcer; the shapes are the contract.
 */

export type RoleName = "hacker" | "volunteer" | "mentor" | "partner" | "organizer";
export type GroupName = "hacker" | "staff" | "mentor" | "partner";

export const ORG = {
  name: "ETHGlobal",
  ens: "ethglobal.eth",
} as const;

export type Branch = {
  label: string;
  ens: string;
  venue: string;
  window: string;
  status: "open" | "scheduled" | "archived";
  members: number;
  online: number;
};

export const BRANCHES: Branch[] = [
  {
    label: "tokyo2026",
    ens: "tokyo2026.ethglobal.eth",
    venue: "Toranomon Hills Forum",
    window: "26–28 Sep 2026",
    status: "open",
    members: 412,
    online: 268,
  },
  {
    label: "singapore2026",
    ens: "singapore2026.ethglobal.eth",
    venue: "Suntec Convention Centre",
    window: "14–16 Nov 2026",
    status: "scheduled",
    members: 0,
    online: 0,
  },
  {
    label: "bangkok2025",
    ens: "bangkok2025.ethglobal.eth",
    venue: "True Digital Park",
    window: "8–10 Nov 2025",
    status: "archived",
    members: 587,
    online: 0,
  },
];

export type Role = {
  name: RoleName;
  group: GroupName;
  vlan: number;
  rate: number;
  ceil: number;
  permissions: string[];
  /** Registry bitmap on the holder's own Membership name. */
  bitmap: string;
  summary: string;
};

export const ROLES: Role[] = [
  {
    name: "hacker",
    group: "hacker",
    vlan: 100,
    rate: 5,
    ceil: 20,
    permissions: [],
    bitmap: "0",
    summary: "Holds no roles on the resolver, so cannot edit its own records.",
  },
  {
    name: "volunteer",
    group: "staff",
    vlan: 10,
    rate: 10,
    ceil: 50,
    permissions: ["member:onboard"],
    bitmap: "0",
    summary: "May onboard hackers. The registrar refuses anything above that.",
  },
  {
    name: "mentor",
    group: "mentor",
    vlan: 200,
    rate: 20,
    ceil: 100,
    permissions: ["member:view"],
    bitmap: "0",
    summary: "Writes its own profile and ssh-pubkey; reads hacker records.",
  },
  {
    name: "partner",
    group: "partner",
    vlan: 400,
    rate: 20,
    ceil: 100,
    permissions: ["member:view"],
    bitmap: "ROLE_SET_RESOLVER",
    summary: "The only role that may point its name at its own resolver.",
  },
  {
    name: "organizer",
    group: "staff",
    vlan: 10,
    rate: 100,
    ceil: 1000,
    permissions: ["member:onboard", "member:revoke", "role:assign", "role:edit", "branch:edit"],
    bitmap: "0",
    summary: "Holds every registrar role plus its admin pair.",
  },
];

export type Group = {
  name: GroupName;
  vlan: number;
  pool: number;
  used: number;
  devices: number;
};

/** Group pools, matching the HTB parent classes on the branch enforcer. */
export const GROUPS: Group[] = [
  { name: "hacker", vlan: 100, pool: 500, used: 463, devices: 214 },
  { name: "staff", vlan: 10, pool: 100, used: 38, devices: 22 },
  { name: "mentor", vlan: 200, pool: 200, used: 74, devices: 19 },
  { name: "partner", vlan: 400, pool: 200, used: 112, devices: 13 },
];

export type Membership = {
  label: string;
  role: RoleName;
  address: string;
  devices: number;
  rate: number;
  online: boolean;
  onboarded: string;
};

export const MEMBERSHIPS: Membership[] = [
  { label: "leo", role: "hacker", address: "0x71C…9f2A", devices: 2, rate: 18.4, online: true, onboarded: "09:12" },
  { label: "ann", role: "organizer", address: "0x4Ba…10C7", devices: 3, rate: 6.1, online: true, onboarded: "07:45" },
  { label: "marco", role: "volunteer", address: "0x9Fe…33d1", devices: 1, rate: 9.8, online: true, onboarded: "08:02" },
  { label: "nova-labs", role: "partner", address: "0x2Dc…88b4", devices: 4, rate: 61.2, online: true, onboarded: "08:30" },
  { label: "priya", role: "mentor", address: "0xA07…5e19", devices: 2, rate: 22.7, online: true, onboarded: "09:40" },
  { label: "kenji", role: "hacker", address: "0x55F…c402", devices: 1, rate: 4.9, online: true, onboarded: "10:15" },
  { label: "sofia", role: "hacker", address: "0xE31…7a6B", devices: 2, rate: 0, online: false, onboarded: "09:58" },
  { label: "dmitri", role: "hacker", address: "0x8cA…2f05", devices: 1, rate: 19.6, online: true, onboarded: "11:03" },
];

/** What ENSCA replaces, for the landing rail. */
export const REPLACEMENTS: { before: string; after: string }[] = [
  { before: "Shared wifi password on a slide", after: "ENS subname and a wallet signature" },
  { before: "One flat network for everyone", after: "A VLAN per role-derived group" },
  { before: "No device isolation", after: "Peers inside your group, walled off outside it" },
  { before: "SSH keys pasted into Discord", after: "ssh-pubkey resolved from the name" },
  { before: "Sponsor API keys, shared and burned", after: "Per-identity quotas at the gateway" },
  { before: "No idea who is on the network", after: "Live sessions keyed to a subname" },
];
