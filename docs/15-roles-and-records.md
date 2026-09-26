# 15 — Roles, restrictions, and who may write which record

The question this document answers: **who may write which text record on whose name.**

It is the question the whole design turns on, and until 2026-09-26 it was answered wrongly. This
records the mechanism, the full permission matrix, and the live evidence that it holds.

---

## 1. The mechanism is ENS's, not ours

ENSv2's `PermissionedResolver` already scopes a write in **two dimensions at once**. Every setter
checks four EAC resources, from `PermissionedResolver.sol`:

```
                                          Parts
       Resources      +-----------------------------+------------------------------+
                      |           Any (*)           |         Specific (1)         |
       +--------------+-----------------------------+------------------------------+
       |      Any (*) |       resource(0, 0)        |      resource(0, <part>)     |
 Names |--------------+-----------------------------+------------------------------+
       | Specific (1) |   resource(<namehash>, 0)   | resource(<namehash>, <part>) |
       +--------------+-----------------------------+------------------------------+
```

where `PermissionedResolverLib.resource(node, part) = keccak256(abi.encode(node, part))` and
`part = partHash(key)` for a text record.

The delegation entrypoint is:

```solidity
function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
    external returns (bool updated);
```

- the caller needs `ROLE_SET_TEXT_ADMIN` on `resource(namehash(toName), 0)`
- it grants `ROLE_SET_TEXT` (`1 << 4`) on `resource(namehash(toName), partHash(key))`

That is exactly "this account may write **this key** on **this name**". We do not need to invent it,
and we no longer do.

### What we had before, and why it was wrong

`BranchRegistrarV2.setOwnRecord(key, value, node)` took the node **from the caller**:

```solidity
uint256 resource = membershipOf[msg.sender];
if (resource == 0) revert NotOnboarded(msg.sender);
if (!hasRoles(keyResource(key), ROLE_EDIT_RECORD, msg.sender)) revert CannotEditKey(...);
RESOLVER.setText(node, key, value);   // node never checked against `resource`
```

The registrar held **root** `ROLE_SET_TEXT` on a resolver shared by every branch, so a member with
one self-editable key could write that key at any node the resolver served: another member's name,
a sibling branch, the organization node, or the `ensca.registrar` discovery record the console
trusts to find registrars. The docstring above it claimed the registrar "adds the per-name
dimension the resolver lacks". The resolver did not lack it; we were not using it.

### What it is now

- `setOwnRecord` **is deleted.** Members call `resolver.setText(theirNode, key, value)` directly.
- `onboard` calls `authorizeTextRoles(membershipDnsName(label), key, owner, true)` for each key the
  member's role lists. The registrar never writes on a member's behalf again.
- `revoke` calls it with `grant = false`, and clears those records.
- `setRecord` (staff) no longer takes a node; it derives one from the membership resource.
- The registrar stores `BRANCH_DNS_NAME` so it can address the resolver by name, derived the same
  way `BRANCH_NODE` is — a supplied name is a supplied namehash.

---

## 2. The roles

### On the branch registrar (`BranchRegistrarV2`)

| Constant | Bit | Scope | Means |
|---|---|---|---|
| `ROLE_MINT` | `1 << 0` | `roleResource(roleId)` | may onboard someone **at that role** |
| `ROLE_EDIT_RECORD` | `1 << 4` | `ROOT_RESOURCE` | may write a record on any membership here (staff) |
| `ROLE_ROLE_EDIT` | `1 << 8` | `ROOT_RESOURCE` | may define, retire and re-sync roles |
| `ROLE_REVOKE` | `1 << 12` | `ROOT_RESOURCE` | may end a membership |

Each has an `_ADMIN` counterpart at `role << 128`, which means "may grant or revoke this role".

`ROLE_REVOKE` is new. It used to be `ROLE_EDIT_RECORD`, which meant that anyone trusted to fix a
typo in an attendee's avatar could also burn every name in the branch. Fixing a record and ending a
membership are not the same privilege, and the record role is the one an organization hands out
widely.

### On the organization registrar (`OrgRegistrar`)

| Constant | Bit | Means |
|---|---|---|
| `ROLE_ENROL` | `1 << 0` | may mint a Member name (held by each branch registrar) |
| `ROLE_SET_ORG_ROLE` | `1 << 4` | may set an org-wide role that applies at every branch |

### Borrowed from ENSv2

| Constant | Bit | Held by | For |
|---|---|---|---|
| `RegistryRolesLib.ROLE_REGISTRAR` | `1 << 0` | branch registrar | `register` |
| `RegistryRolesLib.ROLE_UNREGISTER` | `1 << 12` | branch registrar | `revoke` |
| `RegistryRolesLib.ROLE_RENEW` | `1 << 16` | branch registrar | (granted, currently unused — see §6) |
| `PermissionedResolverLib.ROLE_SET_TEXT` | `1 << 4` | registrar (root), members (per name+key) | writing text |
| `PermissionedResolverLib.ROLE_SET_TEXT_ADMIN` | `1 << 132` | registrar | delegating the above |

### Roles are resources, not role bits

EAC gives 2^256 resources but only 32 regular role bits. A custom org role (`mentor`, `volunteer`,
`crew`) is therefore modelled as a **resource** — `roleResource(roleId) = keccak256(abi.encode(
"ensca.role", roleId))` — not as a bit. There is no ceiling on how many roles an organization can
invent.

### Authority is derived, not granted

EAC enforces a **15-assignees-per-role-per-resource** cap inside `_grantRoles`. `BranchRegistrarV2`
overrides `_getRoles` to *compute* `ROLE_MINT` from the caller's own membership instead of storing a
grant, so it never touches that counter. That is what allows unlimited volunteers. It is also why
authority follows the membership: promote someone and they can onboard in the same transaction;
revoke them and the power is gone with no second grant to remember.

**Record rights are deliberately NOT derived.** They live in the resolver, granted per member at
onboarding. Each `(node, key)` resource has its own assignee counter and exactly one member on it,
so the cap is never approached — and the resolver, not this contract, is the enforcer.

---

## 3. The permission matrix

A worked example: a branch defines `mentor` (may curate their own `avatar` and `ssh.pubkey`) and
`hacker` (may write nothing). Both sit at the same level of the name tree.

### Records

| Actor | own listed key | own unlisted key | another member's name | branch node / `ensca.registrar` |
|---|---|---|---|---|
| Organization owner (root) | — (not onboarded) | — | **via `setRecord`** | **allowed** |
| Branch owner (root) | — (not onboarded) | — | **via `setRecord`** | **allowed** |
| Mentor | **ALLOWED** | DENIED | DENIED | DENIED |
| Hacker | n/a (lists none) | DENIED | DENIED | DENIED |
| Outsider | DENIED | DENIED | DENIED | DENIED |
| Revoked member | DENIED | DENIED | DENIED | DENIED |

"The organization owner can edit everything, the hacker cannot edit anything" — literally the first
and fourth rows. The owner reaches every name through `setRecord` (root `ROLE_EDIT_RECORD`); the
hacker's role lists no editable keys, so nothing is ever delegated to them and every write is
refused by the resolver.

Denials for members come from the **resolver**, as `EACUnauthorizedAccountRoles(resource, 16,
account)` — role 16 is `ROLE_SET_TEXT`. The registrar is not in the path.

### Lifecycle

| Actor | `createBranch` | `defineRole` / `retireRole` | `onboard` (open role) | `onboard` (closed role) | `revoke` |
|---|---|---|---|---|---|
| Org owner | **ALLOWED** | DENIED | DENIED | DENIED | DENIED |
| Branch owner | DENIED | **ALLOWED** | **ALLOWED** | **ALLOWED** | **ALLOWED** |
| Member of a `canOnboard` role | DENIED | DENIED | **ALLOWED** (derived) | DENIED | DENIED |
| Member of any other role | DENIED | DENIED | DENIED | DENIED | DENIED |
| Named delegate for one role | DENIED | DENIED | that role only | that role only | DENIED |
| Record editor (`ROLE_EDIT_RECORD`) | DENIED | DENIED | DENIED | DENIED | **DENIED** |
| Outsider | DENIED | DENIED | DENIED | DENIED | DENIED |
| Expired member | DENIED | DENIED | **DENIED** | DENIED | DENIED |

The last row is also new: `effectiveRole` returns nothing once `block.timestamp >= BRANCH_EXPIRY`.
Previously `membershipOf` was cleared only by `revoke`, so last year's organizer kept minting
forever into a branch that had closed.

### Other restrictions now enforced

- **Labels.** `onboard` applies the same `[a-z0-9-]{1,32}`, no leading/trailing hyphen rule the
  factory and org registrar use. A non-normalised label produces a node ENS will never resolve, so
  records written there are invisible while the label stays permanently taken.
- **Zero owner.** Refused. A membership minted to `address(0)` reserved the label forever and could
  never be revoked.
- **Dangerous registry roles.** `defineRole` refuses `FORBIDDEN_REGISTRY_ROLES` —
  `ROLE_CAN_TRANSFER_ADMIN`, `ROLE_SET_SUBREGISTRY_ADMIN`, `ROLE_SET_RESOLVER_ADMIN`. Memberships
  are soulbound and may not re-point their own name out of the branch's control.
- **Key withdrawal.** `defineRole` clears the previous `editableKeys` before writing the new set.
  Removing a key used to leave it writable by every existing holder forever.

---

## 4. The one behavioural trade-off

Because rights now live in the resolver from the moment of onboarding, **redefining a role changes
what new members get, not what existing members hold.** The old derived-at-call-time model changed
both instantly.

That is the price of letting the resolver be the enforcer, and it is worth paying: an authority that
is computed on every call is an authority no one can audit by reading storage. The catch-up is
explicit:

```solidity
function syncMemberKeys(uint256 anyId, string[] calldata withdraw) external;  // ROLE_ROLE_EDIT
```

It grants whatever the catalogue now lists and withdraws the keys named, since the contract no
longer knows what it handed out before. `test_editing_the_catalogue_changes_existing_holders` pins
this contract.

---

## 5. Live evidence (Sepolia, 2026-09-26)

Deployed fresh and exercised end to end, three times — twice to find problems, once to confirm.

Final deployment: organization `ethglobal2.eth`, factory
`0x4C96E37b679427d362BDE6dFdF123A10f80caA0B`, branch `live-final.ethglobal2.eth`, registry
`0xb582c492…b982`, registrar `0x42717939…b11c`.

**The name is right.** `cast namehash live-final.ethglobal2.eth` equals the registrar's own
`BRANCH_NODE()`, and the constructor now *enforces* that — `NameNodeMismatch` reverts a
deployment whose stored DNS name and stored node describe different things.

**The matrix holds**, from each real wallet against the real resolver:

| actor | target | expected | live result |
|---|---|---|---|
| mentor2 | own `avatar` | ALLOWED | ALLOWED |
| mentor2 | own `wifi.rate` | DENIED | DENIED |
| mentor2 | **hacker1's `avatar`** | DENIED | DENIED |
| mentor2 | branch `ensca.registrar` | DENIED | DENIED |
| hacker1 | own `avatar` | DENIED | DENIED |

**A real member write landed** on the earlier run — tx `0xd284b040…bde9`, signed by the member's
own key — and **the attack was refused on-chain**, as a real transaction:

```
mentor1 → setText(namehash("mentor2.live-20260926.ethglobal2.eth"), "avatar", "ipfs://HIJACKED")
reverted: EACUnauthorizedAccountRoles(
    85919836228232650666444061861467787579888350421477960719618991915995950222191, 16, 0xa57A…DFC7)
```

Role 16 is `ROLE_SET_TEXT`; the resource is `resource(mentor2Node, partHash("avatar"))`.

**A role that could escape the branch is refused.** `defineRole` with `ROLE_SET_RESOLVER`
(`1 << 24`) reverts `ForbiddenRegistryRoles` — verified live.

**The dropped-key case, which an adversarial review found and which the first fix got wrong:**

```
granted at onboarding:  avatar=YES  ssh.pubkey=YES
organization drops ssh.pubkey from the mentor role
after the drop:         avatar=YES  ssh.pubkey=YES    <- still held, by design
after revoke:           avatar=NO   ssh.pubkey=NO     <- the dropped key is ALSO revoked
```

The first version iterated the role's *current* key list on teardown, so a key removed from the
catalogue after onboarding was never handed back — and namehash carries no version id, so that
stale grant would have landed on whoever took the label next. The registrar now records what each
membership was actually granted (`_grantedKeys`) and tears down from that.

**The portal admits on a signature, not a typed name.** Against the live deployment:

```
real member signs  → {"ok":true,"ens_name":"mentor2.live-final.ethglobal2.eth",
                      "role":"mentor","entitlements":{"wifi.rate":"20mbps"}}
stranger signs     → 403
replayed nonce     → 401 "unknown, expired, or already used"
```

**Tests: 134 passing**, including 13 that assert this matrix against live Sepolia state
(`test/LivePermissions.fork.t.sol`).

## 6. Known remaining issues

- **`ROLE_RENEW` is granted and unusable.** `REQUIRED_REGISTRY_ROLES` includes it but V2 exposes no
  `renew`, so memberships cannot be extended past `BRANCH_EXPIRY`. Either add the entrypoint or drop
  the role.
- **The shared resolver is a blast radius.** All branches write into one `PermissionedResolver`, and
  each branch registrar holds root `ROLE_SET_TEXT` on it, so a compromised *registrar* (not member)
  could still write across branches. ENS's own guidance is to give each trust boundary its own
  resolver instance; per-branch resolvers would close this.
- **`OrgRegistrar.ROLE_ENROL` saturates at ~14 branches.** Each `createBranch` grants it to the new
  registrar at `ROOT_RESOURCE`, and EAC caps assignees per resource at 15. Same for `ROLE_SET_TEXT`
  on the resolver. Scope these per-branch, or revoke on close.
- **`releaseMembership` is unpermissioned.** It only acts when the registry already disagrees, but
  it deserves a second look.
- **The org label namespace is global and one-shot.** `onboard`'s `memberLabel` is minted into
  the organization registry by any onboarder at any branch, and `OrgRegistrar` has no unregister
  path. Hit for real during the live run: re-using `mentor2` as a member label on a second branch
  reverted `LabelUnavailable`. So a malicious onboarder can permanently burn an org label —
  including one reserved for a future branch, which then makes `createBranch` for it impossible.
- **A revoked member who holds an org-wide role gets it back.** `revoke` clears `membershipOf`,
  after which `effectiveRole` falls through to `ORG.orgRole(account)`. That is the documented
  §5.4 fallback, but it means a branch cannot fully eject someone the organization has blessed.
- **`BRANCH_EXPIRY` is immutable, so a branch cannot be extended.** Past it, `effectiveRole`
  returns nothing *and* `onboard` cannot register (the registry rejects a past expiry), so a
  branch is permanently closed even if its ENS names are renewed.
- **The old V1 `BranchRegistrar` and its fork test still exist** and still pin V1 addresses. They
  should be deleted; `DeployV2`/`DeployFactory`/`AddBranch`/`SeedRoles` are the live scripts.
