# ENSCA contracts — ENSv2 end-to-end

`BranchRegistrar`, the contract that turns the domain model in
[`../docs/00-domain-model.md`](../docs/00-domain-model.md) into on-chain authority, plus the scripts
that drive a full lifecycle on Sepolia.

> ENSv2 is **Sepolia beta**. ENS Labs states the contracts "are not yet final and may change prior to
> mainnet deployment." Role constants here are imported from `RegistryRolesLib` in the pinned
> `ensdomains/contracts-v2` checkout, never hardcoded — the published docs disagree with themselves
> on `ROLE_RENEW` (the library says `1 << 16`).

## The lifecycle

```
1. Register  ethglobal2.eth            ETHRegistrar, commit → wait 60s → register (USDC)
2. Deploy    branch registry           VerifiableFactory.deployProxy(UserRegistryImpl, salt, init)
3. Attach    ETHRegistry.setSubregistry(labelhash("ethglobal2"), branchRegistry)
4. Deploy    BranchRegistrar(branchRegistry, resolver, expiry)
5. Authorise branchRegistry.grantRootRoles(ROLE_REGISTRAR | ROLE_RENEW, registrar)
6. Onboard   registrar.onboard("leo", wallet, Role.Hacker)   → leo.ethglobal2.eth
7. Verify    reads back through the registry and the ENS indexer
```

Steps 1–5 are one-time branch setup. Step 6 is what a check-in desk calls per attendee.

## Authority model

Three surfaces, deliberately separate:

| Surface | Contract | Governs |
|---|---|---|
| Registry | `PermissionedRegistry` (ENS) | the name: resolver, subregistry, transfer, renewal |
| Resolver | `PermissionedResolver` (ENS) | the records |
| Registrar | `BranchRegistrar` (ours) | who may onboard whom, and at what role |

EAC cannot express "a volunteer may onboard, but only hackers" — `ROLE_REGISTRAR` is binary, so
anyone holding it could mint themselves an organizer. Therefore **no human holds `ROLE_REGISTRAR`**;
the registrar holds it, and humans hold `ROLE_ONBOARD` on the registrar.

### Registrar roles (EAC nybble layout, admin at `role << 128`)

| Role | Nybble | Grants |
|---|---|---|
| `ROLE_ONBOARD` | 0 | create memberships, hacker only |
| `ROLE_PROMOTE` | 1 | onboard or promote to any role |
| `ROLE_REVOKE` | 2 | end a membership |

### Membership role bitmaps on the registry

No membership holds an **admin** role: ENSv2 only allows admin roles to be set at registration
time, so a membership carrying one could never be demoted out of it.

| Role | Registry bitmap | Effect |
|---|---|---|
| `None` | — | sentinel at ordinal 0, so an unset record denies by default |
| `Hacker` | `0` | owns the name, holds no roles — `setText` reverts `EACUnauthorizedAccountRoles` |
| `Volunteer` | `0` | same on-chain; console permission comes from `ROLE_ONBOARD` on the registrar |
| `Mentor` | `0` | record rights come from the resolver, not the registry |
| `Partner` | `ROLE_SET_RESOLVER` | may point the name at its own resolver |
| `Organizer` | `ROLE_SET_RESOLVER \| ROLE_SET_SUBREGISTRY` | full structural control of its own name |

`ROLE_CAN_TRANSFER_ADMIN` is withheld from every membership, which makes them **soulbound**.
Otherwise a volunteer could sell their badge.

## Layout

```
src/BranchRegistrar.sol      the registrar
test/BranchRegistrar.t.sol   unit tests against a local registry
test/Lifecycle.fork.t.sol    rehearsal + live-deployment regression, against Sepolia
script/                      the lifecycle, one script per step
deployments/sepolia.json     written by the scripts
```

## Deployed — Sepolia

Three levels, as the domain model requires: `<member>.<branch>.<org>.eth`.

```
ethglobal2.eth              Organization   org registry   0xEb716b3f…94517
└── tokyo.ethglobal2.eth    Branch         branch registry 0x306DE2Ec…48660
    └── kenji.tokyo.ethglobal2.eth   Membership, role hacker
```

| | |
|---|---|
| Org registry | `0xEb716b3fB749f357be2B74a10647675D11a94517` |
| Branch registry | `0x306DE2Ec8c8B5FE668d31be152b6436481448660` |
| Branch registrar | `0xb0487c88Eaea357aDa85540FB1E8bEfAD2868D52` |
| Resolver | `0x9D8f1376aED12F6F7Ba041285Cce833AcED13092` |
| Volunteer | `0xD3b01908f30Cf733d45869d0ed5Dd9160BB514d9` — holds `ROLE_ONBOARD` only |
| Superseded registrar | `0x9D9F2264528Cd1F5c76c1d94aCaC251e9eF4a05A` — disarmed, reentrancy |

> The first deployment collapsed Organization and Branch into one name, so memberships sat directly
> under `ethglobal2.eth` as `leo.ethglobal2.eth`. That is two levels, not three. `tokyo` now sits
> between them with a registry of its own, and memberships are minted there.

### The volunteer path, executed on-chain

`0xD3b0…14d9` holds `ROLE_ONBOARD` on the branch registrar and nothing else — no `ROLE_PROMOTE`,
no `ROLE_REVOKE`. Signing with that wallet:

- `onboard("kenji", 0x…bEEF, Hacker)` → **succeeded**, tx `0xaa9d3eda…c6afa1`
- `onboard("mallory", …, Organizer)` → **reverted** `CannotGrantRole(0xD3b0…14d9, 5)`, selector `0xf1f1deaa`

That refusal is the thing EAC cannot express on its own, and it is enforced in the registrar.

`kenji.tokyo.ethglobal2.eth` reads back through `UniversalResolverV2.resolve()` as
`role=hacker · wifi.group=hacker · wifi.rate=5mbps · wifi.ceil=20mbps`, and
`roles(kenji, owner) == 0` — the holder owns the name and cannot touch its records.

`ThreeLevelDeploymentTest` asserts all of it.

## Review findings, and what changed

A two-axis review (standards + spec) ran against the first deployment. It found a real
vulnerability, so the registrar was rebuilt, redeployed, and the original disarmed by revoking its
registry roles.

**Reentrancy in `onboard` (fixed).** `REGISTRY.register` mints an ERC1155 to the new owner, which
invokes `onERC1155Received` on it *before* the registrar had written `membershipOf`. A contract
holding `ROLE_ONBOARD` could reenter from that callback, walk past the one-membership-per-wallet
check, and mint a second name — orphaning the first so it could never be promoted or revoked.
`onboard`, `promote` and `revoke` are now `nonReentrant`, and
`test_reentrancy_cannot_mint_a_second_membership` drives a real attacker contract at it.

**Expiry bricked every membership (fixed).** `_requireOnboarded` read the owner back from the
registry, but `getOwner` returns the zero address once a name expires — so after `BRANCH_EXPIRY`
nothing could be revoked, `membershipOf` never cleared, and those wallets could never be onboarded
again. The registrar now records `memberOf[resource]` itself. Two related traps came with it:
`getResource` returns a *different* id once expired (`eacVersionId + 1`), so `_resolveResource`
falls back to the recorded id; and the registry rejects unregistering an already-expired name, so
`revoke` skips that call and just clears bookkeeping.

**`Role.None` sentinel (fixed).** `Hacker` was ordinal 0, so `membership()` reported a stranger as
a hacker. Ordinal 0 is now `None` — deny by default.

**`renew` added.** `ROLE_RENEW` was granted to the registrar but no entrypoint used it, so every
membership was condemned to die at `BRANCH_EXPIRY`.

**`releaseMembership` added** as an escape hatch for bookkeeping that desyncs from the registry.

**Commit secret moved to `REGISTRATION_SECRET`.** It had been a committed constant, which makes the
commitment reconstructable and the registration front-runnable.

Still open, deliberately: there is **no Member layer and no org-scoped role fallback** on-chain
(`docs/13` §1 and §5 describe both) — this deployment covers the Branch and Membership layers only.
`revoke` also leaves the resolver's text records in place; they are unreachable through ENS once the
name is gone, but they are not erased.

## What the docs get wrong

Verified against the pinned `ensdomains/contracts-v2` checkout and live Sepolia:

| Claim | Reality |
|---|---|
| `ROLE_RENEW` is nybble 4 (architecture writeup) | `RegistryRolesLib` says `1 << 16`. Read constants from the source. |
| `UserRegistry.initialize(address,uint256)` via VerifiableFactory | The deployed Sepolia `UserRegistryImpl` does **not** expose that selector — the delegatecall reverts in ~210 gas. The deployed beta build differs from the published source. We deploy a `PermissionedRegistry` directly instead. |
| `PermissionedResolver.initialize(grants, calls)` | Pinned source is `initialize(address,uint256,bytes[])`, and `setText` takes `bytes32 node`, not a DNS-encoded name. |
| `type(uint256).max` as an "all roles" bitmap | EAC bitmaps are nybble-packed; all-ones is invalid. Use `EACBaseRolesLib.ALL_ROLES` (`0x1111…`). |

## Two constraints worth knowing

**Memberships hold no admin roles.** `PermissionedRegistry._getSettableRoles` only permits *regular*
roles to be granted on an already-registered name — admin roles are registration-time only, to stop
an owner escalating their own permissions. A membership that held one could therefore never be
demoted out of it, so `registryBitmapFor` grants none.

**The branch registry is not emancipated.** `promote` and `revoke` need `ROLE_UNREGISTER`,
`ROLE_SET_RESOLVER_ADMIN` and `ROLE_SET_SUBREGISTRY_ADMIN` on `ROOT_RESOURCE`, and three of those
are ENS's "dangerous" roles, so `isEmancipated()` is false. That is the correct trade for an event
branch — the organization must be able to revoke — but it means members are trusting the org, not
just the chain. A branch that wants emancipation gives up `promote`/`revoke` and must reissue
instead.

## Running

```bash
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
forge test -vv                                    # unit
forge test --match-path test/Lifecycle.fork.t.sol --fork-url $SEPOLIA_RPC_URL  # fork
```

Deployment scripts read `PRIVATE_KEY` from `../.env`, which is gitignored and must stay that way.
