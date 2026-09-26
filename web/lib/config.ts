import type { Role } from "@/lib/data";

export const ORG = {
  name: "ENSCA",
  ens: process.env.NEXT_PUBLIC_ORG_ENS ?? "ensca.eth",
  ssid: process.env.NEXT_PUBLIC_SSID ?? "ENSCA",
} as const;

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

// Static bandwidth caps by network_tier (Mbps)
export const TIER_POOL_MBPS: Record<string, number> = {
  basic: 100,
  staff: 500,
  vip: 1000,
};

// Static VLAN tag by network_tier
export const TIER_VLAN: Record<string, number> = {
  basic: 100,
  staff: 10,
  vip: 200,
};

export const ENFORCEMENT = [
  ["Resource", "wifi"],
  ["Enforcer", "fedora-vm · enp10s0u1"],
  ["Identity", "DHCP lease → Membership"],
  ["Resolution", "Membership → Member → deny"],
  ["Revocation", "applied on next check"],
  ["Record cache", "12s old · ttl 60s"],
] as const;
