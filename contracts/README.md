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
test/Fork.t.sol              fork tests against live Sepolia ENSv2
script/                      the lifecycle, one script per step
deployments/sepolia.json     written by the scripts
```

## Running

```bash
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
forge test -vv                                    # unit
forge test --match-path test/Fork.t.sol --fork-url $SEPOLIA_RPC_URL   # fork
```

Deployment scripts read `PRIVATE_KEY` from `../.env`, which is gitignored and must stay that way.
