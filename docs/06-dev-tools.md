# ENSCA — Developer Tools Layer

## Overview

At ETHGlobal today, sponsor API keys are distributed via Discord — shared links, batch codes, no per-person tracking. Keys get shared, rate limits burn out, sponsors get no signal on who used what.

ENSCA provisions per-identity developer tool access at subname mint. Every attendee gets their own API key per service, tied to their ENS subname, with limits set by their role. Usage is tracked per-subname.

## What Gets Provisioned

| Tool | Hacker | Mentor | Pragma | Organizer |
|---|---|---|---|---|
| RPC endpoint | 10k req/day | 50k req/day | 100k req/day | Unlimited |
| Testnet faucet | 0.5 ETH/day | 2 ETH/day | 5 ETH/day | 10 ETH/day |
| IPFS gateway | 1 GB | 5 GB | 10 GB | Unlimited |
| Subgraph indexer | Read only | Read + write | Read + write | Admin |
| Sponsor RPC (e.g. Alchemy) | Shared pool key | Dedicated key | Dedicated key | Admin key |

## Architecture

```
Attendee app / CLI
    │
    ▼
ENSCA API Gateway (port 4000)
    │  Auth: ENS name + wallet signature (or session token)
    │
    ├── /rpc/:chain         → proxy to RPC node, rate limit per identity
    ├── /faucet             → drip testnet ETH, limit per identity
    ├── /ipfs/:path         → proxy to IPFS gateway, quota per identity
    └── /indexer/:query     → proxy to The Graph, quota per identity
```

## API Gateway — Auth Flow

Every tool request carries the attendee's ENS name as identity. First call per session requires a wallet signature; subsequent calls use a short-lived JWT.

```typescript
// POST /auth
// Body: { ensName, signature, nonce }
// Returns: { token, expiresAt }

async function authMiddleware(req, res, next) {
  const token = req.headers['x-ensca-token']

  if (token) {
    const payload = verifyJWT(token)  // throws if invalid/expired
    req.identity = payload.ensName
    return next()
  }

  // First call: verify signature
  const { ensName, signature, nonce } = req.body
  const address = await recoverAddress(signature, nonce)
  const resolvedName = await client.getEnsName({ address })

  if (resolvedName !== ensName) throw new Error('Signature mismatch')
  if (!ensName.endsWith('.tokyo2026.ethglobal.eth')) throw new Error('Not an event subname')

  req.identity = ensName
  next()
}
```

## RPC Proxy

```typescript
// GET/POST /rpc/:chain
// Proxies to underlying RPC node with per-identity rate limiting

const rateLimiter = new Map<string, { count: number, resetAt: number }>()

async function rpcProxy(req, res) {
  const identity = req.identity  // set by auth middleware
  const policy = await getPolicy(identity)

  // Check quota
  const usage = rateLimiter.get(identity) ?? { count: 0, resetAt: Date.now() + 86400000 }
  if (usage.count >= policy.rpcLimit) {
    return res.status(429).json({
      error: 'Daily RPC quota exceeded',
      limit: policy.rpcLimit,
      resetAt: usage.resetAt,
      identity,
    })
  }

  usage.count++
  rateLimiter.set(identity, usage)

  // Proxy to RPC node
  const response = await fetch(RPC_ENDPOINT, {
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  })

  // Log usage
  await logUsage({ identity, tool: 'rpc', chain: req.params.chain, timestamp: Date.now() })

  res.json(await response.json())
}
```

## Faucet

```typescript
// POST /faucet
// Body: { toAddress } — drips testnet ETH to address

async function faucet(req, res) {
  const identity = req.identity
  const policy = await getPolicy(identity)

  // Check daily drip limit
  const todayUsage = await getDailyFaucetUsage(identity)
  const limit = parseEther(policy.faucetLimit.replace('eth/day', ''))

  if (todayUsage >= limit) {
    return res.status(429).json({ error: 'Daily faucet limit reached', identity })
  }

  const drip = limit / 2n  // drip half the daily limit per request
  await walletClient.sendTransaction({
    to: req.body.toAddress,
    value: drip,
  })

  await logUsage({ identity, tool: 'faucet', amount: drip.toString() })
  res.json({ txHash, amount: formatEther(drip) })
}
```

## Sponsor API Key Management

Sponsors provide a pool of API keys at event setup. ENSCA assigns them per-identity at mint time based on role:

```typescript
// At subname mint:
async function provisionSponsorKeys(ensName: string, role: string) {
  const keys = await sponsorKeyPool.assign(ensName, role)
  // keys = { alchemy: 'key_abc123', thegraph: 'key_xyz456', ... }

  // Store in ENSCA DB, served via /my-keys endpoint
  await db.storeProvisionedKeys(ensName, keys)
}

// GET /my-keys
// Returns the attendee's personal API keys
async function myKeys(req, res) {
  const keys = await db.getProvisionedKeys(req.identity)
  res.json(keys)
}
```

For sponsor keys, ENSCA acts as an authenticating proxy — the sponsor's real key is never exposed to the attendee. All calls go through the ENSCA gateway, which injects the real key server-side.

## Usage Tracking

Every API call is logged to a time-series store:

```typescript
interface UsageEvent {
  identity: string        // ENS name
  tool: string           // 'rpc' | 'faucet' | 'ipfs' | 'indexer'
  chain?: string
  bytes?: number
  timestamp: number
  success: boolean
}
```

Aggregated in real-time for the organizer dashboard. Also used for post-event attestations (which sponsors' tools did this hacker actually use).

## CLI Tool

Attendees get a small CLI tool for easy access:

```bash
# Install
npm i -g ensca-cli

# Authenticate (signs with wallet once, stores session token)
ensca login philo.tokyo2026.ethglobal.eth

# Use RPC
ensca rpc eth_blockNumber --chain sepolia

# Get faucet
ensca faucet 0xYourAddress --chain sepolia

# Check usage
ensca usage
# RPC: 1,432 / 10,000 today
# Faucet: 0.25 / 0.5 ETH today
# IPFS: 234 MB / 1 GB

# Get my API keys
ensca keys
# Alchemy: alch_abc123...
# The Graph: apiKey_xyz...
```
