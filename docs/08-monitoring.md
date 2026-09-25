# ENSCA — Monitoring, Perimeter Detection & Usage Analytics

## Overview

ENSCA gives organizers real-time visibility into who is on the network, what they're using, and where they are in the venue — all tied to real identities (ENS names), not anonymous MACs or IPs.

## What Gets Tracked

| Signal | Source | Granularity |
|---|---|---|
| Device connected/disconnected | FreeRADIUS accounting | Per event, per identity |
| Bandwidth used | FreeRADIUS accounting | Per session, per identity |
| RPC requests | API gateway logs | Per call, per chain |
| Faucet drips | API gateway logs | Per request, per identity |
| IPFS data transferred | API gateway logs | Per request |
| SSH sessions | sshd PAM accounting | Session start/end, per identity |
| Active presence | Device on network = at venue | Real-time |

## Perimeter Detection

If your device is authenticated on the ENSCA network, you're physically at the venue. This gives organizers a real-time attendance map without QR scanning or badge tapping.

```typescript
// GET /admin/presence
// Returns: list of currently connected ENS names + their roles

async function currentPresence(): Promise<PresenceEntry[]> {
  const activeSessions = await db.query(`
    SELECT ens_name, role, connected_at, ip_address, device_count
    FROM sessions
    WHERE disconnected_at IS NULL
    ORDER BY connected_at DESC
  `)

  return activeSessions.map(s => ({
    ensName: s.ens_name,
    role: s.role,
    connectedSince: s.connected_at,
    deviceCount: s.device_count,
    minutesOnline: Math.floor((Date.now() - s.connected_at) / 60000),
  }))
}
```

Use cases:
- Know how many hackers are still active at 3am
- See if a mentor is physically present before directing a hacker to them
- Verify a speaker arrived before their talk
- Detect stragglers when venue needs to close

## FreeRADIUS Accounting

FreeRADIUS sends accounting packets (Start, Interim-Update, Stop) for every session. The ENSCA accounting handler writes these to a time-series DB:

```python
# /etc/freeradius/3.0/mods-enabled/detail.log
# Custom accounting module

def accounting(p):
    identity = p.get('User-Name')  # ENS name
    session_id = p.get('Acct-Session-Id')
    status = p.get('Acct-Status-Type')  # Start | Interim-Update | Stop

    if status == 'Start':
        db.insert_session(identity, session_id, p.get('Calling-Station-Id'))

    elif status == 'Interim-Update':
        db.update_session(session_id,
            bytes_in=p.get('Acct-Input-Octets'),
            bytes_out=p.get('Acct-Output-Octets'),
            duration=p.get('Acct-Session-Time')
        )

    elif status == 'Stop':
        db.close_session(session_id,
            total_bytes_in=p.get('Acct-Input-Octets'),
            total_bytes_out=p.get('Acct-Output-Octets'),
            duration=p.get('Acct-Session-Time')
        )
        # Trigger post-event attestation writer if event ended
```

## Usage Analytics

Aggregated per-identity usage across all tools:

```typescript
interface IdentityUsage {
  ensName: string
  role: string

  network: {
    totalBytesIn: bigint
    totalBytesOut: bigint
    sessionsCount: number
    totalHoursOnline: number
  }

  rpc: {
    requestsTotal: number
    requestsByChain: Record<string, number>
    requestsToday: number
  }

  faucet: {
    totalDripped: bigint    // in wei
    requestsCount: number
  }

  ipfs: {
    bytesServed: bigint
    requestsCount: number
  }

  ssh: {
    sessionsCount: number
    totalMinutes: number
    commandsRun: number
  }
}
```

## Organizer Dashboard

Real-time web dashboard (Next.js, polling every 10s):

```
ENSCA — Tokyo 2026 — Live

PRESENCE (312 / 500 registered)
  Hackers:     241 online  │████████████████░░░░│
  Mentors:      18 online  │████░░░░░░░░░░░░░░░░│
  Organizers:   12 online  │███░░░░░░░░░░░░░░░░░│
  Volunteers:   24 online  │████░░░░░░░░░░░░░░░░│
  Pragma:       17 online  │████░░░░░░░░░░░░░░░░│

NETWORK (last hour)
  Bandwidth in:  4.2 GB    Bandwidth out: 1.1 GB
  Active VLANs:  287

TOP CONSUMERS (bandwidth, last hour)
  philo.tokyo2026.ethglobal.eth     2.1 GB  [hacker]
  alice.tokyo2026.ethglobal.eth     890 MB  [hacker]
  bob.tokyo2026.ethglobal.eth       340 MB  [pragma]

RPC USAGE (today)
  Total requests:  142,381
  Sepolia:          89,204
  Mainnet:          53,177
  Near limit (>80%): 3 identities  ⚠

FAUCET (today)
  ETH dripped:   48.3 / 200 ETH budget
  Requests:      214

ALERTS
  ⚠  eve.tokyo2026.ethglobal.eth — RPC quota 92% used (9,200 / 10,000)
  ⚠  Unknown device (MAC: 44:55:66:77) — repeated auth failures
```

## Anomaly Detection

Simple rule-based alerts:

```typescript
const ALERTS = [
  {
    name: 'rpc-quota-warning',
    check: (usage: IdentityUsage) => usage.rpc.requestsToday > usage.rpc.dailyLimit * 0.8,
    message: (u) => `${u.ensName} at ${Math.round(u.rpc.requestsToday / u.rpc.dailyLimit * 100)}% RPC quota`,
  },
  {
    name: 'excessive-bandwidth',
    check: (usage: IdentityUsage) => usage.network.totalBytesIn > 10_000_000_000n, // 10 GB
    message: (u) => `${u.ensName} has used ${formatBytes(u.network.totalBytesIn)} — possible abuse`,
  },
  {
    name: 'auth-failure-flood',
    check: (mac: string) => getFailureCount(mac) > 10,
    message: (mac) => `MAC ${mac} has 10+ failed auth attempts`,
  },
]
```

## Post-Event Attestations

After the event ends, the usage data is written back into ENS text records as attestations:

```typescript
async function writePostEventAttestations(ensName: string) {
  const usage = await getFullUsage(ensName)

  const records = {
    'hours-online': String(usage.network.totalHoursOnline),
    'rpc-requests': String(usage.rpc.requestsTotal),
    'eth-received': formatEther(usage.faucet.totalDripped),
    'sponsors-used': usage.sponsorsUsed.join(','),
  }

  // Write via ENSCA gateway (signed by event authority key)
  await gateway.setTextRecords(ensName, records)
}
```

These records become a permanent on-chain record. `philo.tokyo2026.ethglobal.eth` carries proof that philo was at Tokyo 2026, hacked for 34 hours, used Alchemy and The Graph, and submitted a project.
