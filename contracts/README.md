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

| Role | Registry bitmap | Effect |
|---|---|---|
| `Hacker` | `0` | owns the name, holds no roles — `setText` reverts `EACUnauthorizedAccountRoles` |
| `Volunteer` | `0` | same on-chain; console permission comes from `ROLE_ONBOARD` on the registrar |
| `Mentor` | `0` | record rights come from the resolver, not the registry |
| `Partner` | `ROLE_SET_RESOLVER \| ROLE_SET_RESOLVER_ADMIN` | may point the name at its own resolver |
| `Organizer` | `ROLE_SET_RESOLVER \| ROLE_SET_SUBREGISTRY \| admins` | full structural control of its own name |

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

Live as of 2026-09-25. `ethglobal2.eth` is registered, its branch is attached, and one membership
exists with entitlements readable through the ENS UniversalResolver.

| | |
|---|---|
| Branch name | `ethglobal2.eth` (expiry `1821903888`) |
| Branch registry | [`0xEb716b3fB749f357be2B74a10647675D11a94517`](https://sepolia.etherscan.io/address/0xEb716b3fB749f357be2B74a10647675D11a94517) |
| Branch resolver | [`0x9D8f1376aED12F6F7Ba041285Cce833AcED13092`](https://sepolia.etherscan.io/address/0x9D8f1376aED12F6F7Ba041285Cce833AcED13092) |
| BranchRegistrar | [`0x9D9F2264528Cd1F5c76c1d94aCaC251e9eF4a05A`](https://sepolia.etherscan.io/address/0x9D9F2264528Cd1F5c76c1d94aCaC251e9eF4a05A) |
| Owner | `0xE08224B2CfaF4f27E2DC7cB3f6B99AcC68Cf06c0` |
| First membership | `leo.ethglobal2.eth` — role `hacker`, registry bitmap `0` |

Verified through the canonical read path — `UniversalResolverV2.resolve()` on the DNS-encoded name
returns our resolver and these records:

```
role = hacker · wifi.group = hacker · wifi.rate = 5mbps · wifi.ceil = 20mbps
```

`LiveDeploymentTest` in `test/Lifecycle.fork.t.sol` asserts all of the above and is the regression
test for the deployment.

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
