# ENS Identity Layer (Future Phase)

The ENS identity layer replaces username/password with on-chain identity. This is Phase 2 of the build plan.

**Current status:** Not implemented. The control plane is ready to receive ENS-resolved group assignments. Auth is still username/password → tier.

---

## Planned Subname Hierarchy

```
ethglobal.eth                          ← ETHGlobal controls
└── tokyo2026.ethglobal.eth            ← per-event subdomain
    ├── philo.tokyo2026.ethglobal.eth  ← per-attendee subname
    └── ann.tokyo2026.ethglobal.eth
```

Each attendee gets a subname minted at check-in. The subname carries role + access policy in ENS text records.

---

## Planned Text Record Schema

### WiFi Policy Records

| Key | Example | Maps to |
|---|---|---|
| `wifi.group` | `hacker` | group name in proxy DB |
| `wifi.rate` | `5mbps` | guaranteed rate (tc HTB child class) |
| `wifi.ceil` | `20mbps` | ceiling rate |
| `wifi.hours` | `24/7` | access window |

### SSH Records (Phase 4)

| Key | Example | Purpose |
|---|---|---|
| `ssh-pubkey` | `ssh-ed25519 AAAA...` | AuthorizedKeysCommand handler |
| `ssh-policy` | `sudo:no,shell:/bin/bash` | session policy |

### Tool Quota Records (Phase 4)

| Key | Example | Purpose |
|---|---|---|
| `tools-rpc-limit` | `10000/day` | overrides group RPC limit for this identity |
| `tools-faucet-limit` | `0.5eth/day` | faucet drip cap |

---

## Planned Auth Flow (Phase 2)

```
1. Device connects → captive portal shows wallet connect UI
2. Portal issues EIP-191 challenge (nonce)
3. User signs with wallet → portal recovers signer address
4. Portal reverse ENS lookup: address → subname under event domain
5. Portal reads wifi.group text record via CCIP-Read resolver
6. Portal calls proxy /internal/group-by-tier/<group_name> or looks up group by name
7. Portal calls /internal/session-created with session UUID + group_id
8. Proxy authorizes proxy requests by session IP as before
```

Nothing in the proxy changes for Phase 2 — only the portal's auth mechanism changes.

---

## ENS Design for Control Plane (Phase 3+)

See `13-ens-design.md` for the full on-chain design: ENSv2 registries, Enhanced Access Control (EAC), `BranchRegistrar`, and the role→group mapping.
