# SSH Layer (Future Phase 4)

SSH access to shared event machines gated by ENS identity. Not implemented yet.

**Current status:** No SSH access control. This is Phase 4 of the build plan.

---

## Planned Architecture

Standard SSH public key authentication with ENS as the key store:

```
ssh philo.tokyo2026.ethglobal.eth@devbox.ensca.eth

sshd
  └── AuthorizedKeysCommand /usr/local/bin/ensca-keys %u
        └── %u = "philo.tokyo2026.ethglobal.eth"
        └── resolve ENS name → read ssh-pubkey text record
        └── return "ssh-ed25519 AAAA..." to sshd
        └── standard challenge/response
```

The ENS name IS the SSH username. Everything else is standard OpenSSH.

---

## sshd Configuration (planned)

```
AuthorizedKeysCommand /usr/local/bin/ensca-keys %u
AuthorizedKeysCommandUser nobody
UsePAM yes
PubkeyAuthentication yes
PasswordAuthentication no
```

---

## ensca-keys Binary (planned)

```typescript
// /usr/local/bin/ensca-keys <ens-name>
// Returns: authorized_keys line or empty (denies access)

const pubkey = await client.getEnsText({ name, key: 'ssh-pubkey' })
if (!pubkey) process.exit(1)
process.stdout.write(pubkey + '\n')
```

5-minute local cache at `/var/cache/ensca/keys/`. Falls back to cached key if RPC unavailable.

---

## Hardware Wallet SSH

Ledger/Trezor work as SSH keys via PKCS#11:

```bash
ledger-agent identity@ledger -e ed25519
# Output: ssh-ed25519 AAAA... identity@ledger
# Store in ENS ssh-pubkey text record

# SSH with hardware wallet signing:
ledger-agent identity@ledger -- ssh philo.tokyo2026.ethglobal.eth@devbox.ensca.eth
```

Private key never leaves the device.

---

## Security Model

| Risk | Mitigation |
|---|---|
| RPC unavailable during auth | 5-min local cache of last-known pubkey |
| Subname transferred to new owner | New owner's key takes effect on next SSH connection |
| Attacker knows ENS name | Still needs private key matching ssh-pubkey record |
| Invalid ENS name as username | ensca-keys validates event suffix before resolving |
