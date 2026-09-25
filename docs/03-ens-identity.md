# ENSCA — ENS Identity Layer

## Overview

The ENS identity layer is the foundation everything else reads from. It defines the subname hierarchy, the text record schema, and the resolver architecture that serves policy to all other components in real time.

## Subname Hierarchy

```
ethglobal.eth                          ← ETHGlobal controls
└── tokyo2026.ethglobal.eth            ← per-event subdomain
    ├── philo.tokyo2026.ethglobal.eth  ← per-attendee subname
    ├── ann.tokyo2026.ethglobal.eth
    ├── marco.tokyo2026.ethglobal.eth
    └── ...
```

Each event gets its own second-level subdomain. Each attendee gets a third-level subname minted at check-in. The subname is permanent — it persists after the event as a record of attendance and contribution.

## Text Record Schema

All policy is stored in ENS text records on the attendee's subname.

### Identity Records

| Key | Example Value | Purpose |
|---|---|---|
| `role` | `hacker` | Primary role at event |
| `event` | `tokyo2026` | Event slug |
| `checkin` | `1750000000` | Unix timestamp of check-in |

### WiFi Policy Records

| Key | Example Value | Purpose |
|---|---|---|
| `wifi-vlan` | `100` | VLAN ID assigned to this identity |
| `wifi-bandwidth` | `50mbps` | Max bandwidth |
| `wifi-hours` | `24/7` | Access window (or `08:00-23:00`) |
| `wifi-ssid` | `ethglobal-hacker` | SSID this identity connects to |

### SSH Records

| Key | Example Value | Purpose |
|---|---|---|
| `ssh-pubkey` | `ssh-ed25519 AAAA...` | SSH public key (replaces authorized_keys) |
| `ssh-policy` | `sudo:no,shell:/bin/bash` | Session policy |
| `ssh-commands` | `git,node,npm,forge,cast` | Allowed command allowlist |
| `ssh-homedir` | `/home/hackers/philo` | Home directory on shared machines |

### Tool Quota Records

| Key | Example Value | Purpose |
|---|---|---|
| `tools-rpc-limit` | `10000/day` | RPC request quota |
| `tools-faucet-limit` | `0.5eth/day` | Faucet drip limit |
| `tools-ipfs-limit` | `1gb` | IPFS gateway quota |
| `tools-indexer` | `true` | Indexer access enabled |

### Post-Event Attestation Records (written after event)

| Key | Example Value | Purpose |
|---|---|---|
| `built` | `ensca` | Project name shipped |
| `prizes` | `best-ens-hack` | Prizes won |
| `sponsors-used` | `alchemy,the-graph` | Sponsor tools used |
| `hours-online` | `34` | Hours on event network |

## Role Definitions

```typescript
const ROLES = {
  hacker: {
    vlan: 100,
    bandwidth: '50mbps',
    hours: '24/7',
    ssid: 'ethglobal-hacker',
    rpcLimit: '10000/day',
    faucetLimit: '0.5eth/day',
    ipfsLimit: '1gb',
    sudo: false,
  },
  organizer: {
    vlan: 10,
    bandwidth: 'unlimited',
    hours: '24/7',
    ssid: 'ethglobal-staff',
    rpcLimit: 'unlimited',
    faucetLimit: '10eth/day',
    ipfsLimit: 'unlimited',
    sudo: true,
  },
  mentor: {
    vlan: 200,
    bandwidth: '100mbps',
    hours: '24/7',
    ssid: 'ethglobal-mentor',
    rpcLimit: '50000/day',
    faucetLimit: '2eth/day',
    ipfsLimit: '5gb',
    sudo: false,
  },
  volunteer: {
    vlan: 300,
    bandwidth: '20mbps',
    hours: '08:00-23:00',
    ssid: 'ethglobal-volunteer',
    rpcLimit: '2000/day',
    faucetLimit: '0.1eth/day',
    ipfsLimit: '500mb',
    sudo: false,
  },
  pragma: {
    vlan: 400,
    bandwidth: '100mbps',
    hours: 'conf-hours',
    ssid: 'ethglobal-pragma',
    rpcLimit: '100000/day',
    faucetLimit: '5eth/day',
    ipfsLimit: '10gb',
    sudo: false,
  },
}
```

## Resolver Architecture

ENSCA uses an offchain CCIP-Read resolver (EIP-3668) so text records can be updated without gas costs. This is critical for an event context where records need to be written at check-in, updated during the event, and enriched post-event.

```
Client (RADIUS / ensca-keys / API gateway)
    │
    ▼
ENS Registry (mainnet)
    │  looks up resolver for *.tokyo2026.ethglobal.eth
    ▼
ENSCA Wildcard Resolver (on-chain, ENSIP-10)
    │  reverts with OffchainLookup (EIP-3668)
    ▼
ENSCA Gateway (offchain, your server)
    │  serves signed text record data
    ▼
Resolver verifies signature
    │
    ▼
Returns record to caller
```

The gateway stores records in a simple database (Postgres or even flat JSON for a demo). It signs responses with a known signer key. The on-chain resolver verifies the signature before returning data — this means the gateway can't lie without the on-chain resolver rejecting the response.

## Subname Minting Flow

```
1. Attendee arrives at check-in desk
2. Staff scan ticket → verify registration
3. Check-in UI prompts attendee: enter ENS label + SSH public key
4. Relayer constructs transaction:
     ENSRegistry.setSubnodeRecord(
       namehash('tokyo2026.ethglobal.eth'),
       labelhash(label),
       owner = attendee_address,
       resolver = ENSCA_RESOLVER,
       ttl = 0
     )
5. Relayer submits + pays gas
6. ENSCA Gateway writes text records to its DB:
     role, wifi-vlan, wifi-bandwidth, ssh-pubkey, tools-*
7. Attendee's subname is live — all infrastructure reads it immediately
```

Minting takes ~10 seconds. No gas cost to attendee.

## Revocation

Revoking access means burning the subname:

```typescript
// Organizer revokes philo's access
ENSRegistry.setSubnodeRecord(
  namehash('tokyo2026.ethglobal.eth'),
  labelhash('philo'),
  owner = ZERO_ADDRESS,  // burns it
  resolver = ZERO_ADDRESS,
  ttl = 0
)
```

Once revoked:
- ENS resolves to null
- RADIUS denies WiFi on next auth attempt (or next re-auth cycle, max 4 hours)
- SSH denies on next connection attempt
- API gateway returns 403

## Normalization

All ENS names must be normalized per ENSIP-15 before namehashing or resolving.

```typescript
import { normalize, namehash } from 'viem/ens'

function toNode(name: string): `0x${string}` {
  const normalized = normalize(name)  // throws on invalid
  return namehash(normalized)
}
```

Labels for attendee subnames are restricted at check-in to `[a-z0-9-]` only, max 32 chars, to avoid normalization edge cases with Unicode labels.
