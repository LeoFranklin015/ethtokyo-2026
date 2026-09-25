# ENSCA — SSH Layer

## Overview

SSH access to shared event machines (dev boxes, build servers) is gated by ENS identity. The attendee's SSH public key is stored in their ENS text record at check-in. `sshd` resolves the ENS name to fetch the authorized key — no manual `authorized_keys` management, no key distribution, no shared passwords.

## How It Works

Standard SSH public key authentication, with ENS as the key store instead of `~/.ssh/authorized_keys`:

```
ssh philo.tokyo2026.ethglobal.eth@devbox.ensca.eth

sshd
  └── AuthorizedKeysCommand /usr/local/bin/ensca-keys %u
        └── %u = "philo.tokyo2026.ethglobal.eth"
        └── resolve ENS name
        └── read text record: ssh-pubkey
        └── return "ssh-ed25519 AAAA..." to sshd
        └── sshd does standard challenge/response against that key
        └── client signs with private key (hardware wallet or normal)
```

The ENS name IS the SSH username. Everything else is standard OpenSSH.

## sshd Configuration

```
# /etc/ssh/sshd_config

AuthorizedKeysCommand /usr/local/bin/ensca-keys %u
AuthorizedKeysCommandUser nobody

UsePAM yes
PubkeyAuthentication yes
PasswordAuthentication no

# Per-identity session policy applied after auth
AuthorizedPrincipalsCommand /usr/local/bin/ensca-authz %u
AuthorizedPrincipalsCommandUser nobody
```

## ensca-keys Binary

Fetches `ssh-pubkey` text record from ENS and returns it as an `authorized_keys` line:

```typescript
#!/usr/bin/env node
// /usr/local/bin/ensca-keys
// Usage: ensca-keys <ens-name>
// Returns: authorized_keys line or empty (access denied)

import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'

const client = createPublicClient({ chain: mainnet, transport: http() })

async function main() {
  const username = process.argv[2]

  // Validate it's an event subname
  if (!username?.endsWith('.tokyo2026.ethglobal.eth')) {
    process.exit(1)
  }

  try {
    const name = normalize(username)

    // Check cache first (5 min TTL) — RPC resilience
    const cached = getCache(name)
    if (cached) { process.stdout.write(cached + '\n'); process.exit(0) }

    const pubkey = await client.getEnsText({ name, key: 'ssh-pubkey' })
    if (!pubkey) process.exit(1)

    // Validate format
    if (!pubkey.startsWith('ssh-ed25519 ') && !pubkey.startsWith('ssh-rsa ')) {
      process.exit(1)
    }

    setCache(name, pubkey)
    process.stdout.write(pubkey + '\n')
    process.exit(0)
  } catch {
    // Fall through to deny
    process.exit(1)
  }
}

main()
```

Cache stored in `/var/cache/ensca/keys/` as files named by namehash. Fallback to cached key if RPC is unavailable, preserving access during network issues.

## ensca-authz — Post-Auth Policy

After SSH auth succeeds, a PAM exec script reads the `ssh-policy` and `ssh-commands` text records and enforces them for the session:

```bash
#!/bin/bash
# /usr/local/bin/ensca-authz
# Called by PAM after successful auth
# PAM_USER = ENS name

ENS_NAME="$PAM_USER"
POLICY=$(curl -sf "http://localhost:3000/ssh-policy/$ENS_NAME")

if [ -z "$POLICY" ]; then exit 1; fi

SUDO=$(echo "$POLICY" | jq -r '.sudo')
SHELL=$(echo "$POLICY" | jq -r '.shell')
HOMEDIR=$(echo "$POLICY" | jq -r '.homedir')

# Create home dir if needed
mkdir -p "$HOMEDIR"

# Set PAM environment
echo "HOME=$HOMEDIR"
echo "SHELL=$SHELL"

# Write ulimits
cat > /etc/security/limits.d/ensca-$PAM_USER.conf << EOF
$PAM_USER hard nproc 100
$PAM_USER hard nofile 1024
$PAM_USER hard fsize 1048576
EOF

exit 0
```

## ensca-shell-filter — Command Allowlist

For roles with restricted commands (`ssh-commands` record), a shell wrapper enforces the allowlist:

```typescript
#!/usr/bin/env node
// /usr/local/bin/ensca-shell-filter
// Set as ForceCommand in sshd Match block

const ensName = process.env.USER
const requestedCmd = process.env.SSH_ORIGINAL_COMMAND

async function main() {
  const policy = await fetch(`http://localhost:3000/ssh-policy/${ensName}`)
    .then(r => r.json())

  const allowed = policy.commands  // ['git', 'node', 'npm', 'forge', 'cast']

  if (!requestedCmd) {
    // Interactive shell — only allowed if no command restriction
    if (allowed.length === 0) {
      exec(process.env.SHELL)
    } else {
      console.error('Interactive shells not permitted for your role.')
      process.exit(1)
    }
  }

  const cmd = requestedCmd.split(' ')[0]
  if (!allowed.includes(cmd)) {
    console.error(`Command '${cmd}' not permitted for your role.`)
    process.exit(1)
  }

  exec(requestedCmd)
}
```

## Hardware Wallet SSH

Ledger and Trezor work as SSH keys via PKCS#11 — no custom code needed.

**Ledger:**
```bash
# Install ledger-agent
pip install ledger-agent

# Derive SSH public key from wallet
ledger-agent identity@ledger -e ed25519

# Output: ssh-ed25519 AAAA... identity@ledger
# → store this in ENS ssh-pubkey text record
```

**Trezor:**
```bash
pip install trezor-agent
trezor-agent identity@trezor -e ed25519
# Same output format
```

At SSH time, the agent handles signing:
```bash
ledger-agent identity@ledger -- ssh philo.tokyo2026.ethglobal.eth@devbox.ensca.eth
```

The hardware wallet button press authorizes the SSH session. The private key never leaves the device.

## Check-In Flow — SSH Key Registration

At check-in, the attendee provides their SSH public key:

```
1. Staff opens check-in UI
2. Attendee pastes SSH public key (or derives from hardware wallet on the spot)
3. UI validates format: must be ssh-ed25519 or ssh-rsa
4. Relayer writes ssh-pubkey to ENS text record along with other records
5. SSH access live within ~30 seconds (ENS propagation + cache)
```

For attendees without an SSH key at check-in: they can add it later via the self-service portal by signing with their wallet to prove ENS name ownership.

## Security Model

| Risk | Mitigation |
|---|---|
| RPC unavailable during auth | 5-min local cache of last-known pubkey |
| ENS record poisoned mid-session | Key read once at session start, not re-checked |
| Subname transferred to new owner | New owner's key takes effect on next SSH connection — by design, same as key rotation |
| Attacker knows ENS name | Still needs private key matching the ssh-pubkey record |
| Replay attack | Not applicable — standard SSH challenge/response, not signature-based |
| Invalid ENS name as username | `ensca-keys` validates `.tokyo2026.ethglobal.eth` suffix before resolving |

## Self-Service Key Update

Attendee can update their SSH public key after check-in without staff involvement:

```
POST /update-ssh-key
{
  "ensName": "philo.tokyo2026.ethglobal.eth",
  "newPubkey": "ssh-ed25519 AAAA...",
  "signature": "0x..."  // EIP-191 signature of (ensName + newPubkey + nonce)
}

Server:
1. Verify signature → recover address
2. Confirm address owns philo.tokyo2026.ethglobal.eth
3. Update ssh-pubkey in ENSCA gateway DB
4. Clear local cache for this name
5. New key active within 30 seconds
```
