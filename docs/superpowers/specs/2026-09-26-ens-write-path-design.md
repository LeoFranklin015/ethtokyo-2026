# ENS Subdomain Issuance — Full Product Design

**Date:** 2026-09-26
**Status:** Draft for review
**Supersedes for the write path:** `docs/13-ens-design.md` (V1) and `docs/superpowers/specs/2026-09-26-ens-identity-vlan-design.md` (read-only console)

## Goal

Deliver a working end-to-end product that issues ENS subdomains on Sepolia ENSv2: fresh contracts deployed onto an owned `.eth` org name, a browser wallet write path for staff, and console UI wiring — while preserving the invariant that a hacker cannot edit any record.

## The Governing Invariant

**A hacker cannot edit any record. This is proven, not built.**

It already holds on-chain by construction. The seeded `hacker` role has `registryBitmap = 0`, no `selfEditable` keys, `canOnboard = false`, and `openToOnboarders = true`. Consequences:

- `onboard(...)` by a hacker reverts on the `ROLE_MINT` authority check (hacker has `canOnboard = false`).
- `setOwnRecord(...)` by a hacker reverts `CannotEditKey` (hacker's role lists no `selfEditable` keys).

Every layer must preserve this:

- **Contracts:** SeedRoles re-establishes the exact `hacker` spec. A forge test asserts a hacker wallet reverts on both `onboard` and `setOwnRecord`.
- **Write path:** the browser only ever calls `onboard` / `setOwnRecord` on the registrar — never `setText` on the resolver directly. The contract's reverts ARE the authorization.
- **UI:** no edit affordance is rendered for a role whose on-chain `selfEditable` set is empty; no mintable role is offered to a wallet that cannot onboard. UI hiding is convenience; the contract refusing is the guarantee.

## Settled Architectural Choices

1. **Signer model:** staff browser wallet — client-side signing, no server keys. Connection via **WalletConnect** (+ injected/MetaMask).
2. **ENS layer:** ENSv2 on Sepolia — drive the deployed V2 registrars directly, not generic ENS APIs.
3. **Write architecture:** client-signed; server stays read-only; a server pre-check route runs `simulateContract` before the wallet is prompted, so bad txs fail fast with a readable reason. The server holds no key and sends no tx.
4. **Role type source:** on-chain catalogue only. Delete the hardcoded `RoleName` union; everything role-shaped derives from the `RoleDefined` catalogue.
5. **Deploy:** fresh deploy onto an org `.eth` name the deployer already owns (no commit-reveal registration in scope). Deploy runs from this Mac; secrets live in shell env for the deploy session only — never in repo, ledger, or spec/plan files.
6. **Branches:** created dynamically from the UI. A `BranchRegistrarV2` is immutable-bound to one branch node, so each dynamic branch deploys its own registry + registrar (mirrors the existing per-branch topology).

## Grounded On-Chain Facts

Verified against `contracts/` source and the pinned `@ens-v2` submodule (`ensdomains/contracts-v2` @ `48b3e2d3`).

### BranchRegistrarV2 constructor (verbatim)

```
constructor(IPermissionedRegistry registry, IBranchResolver resolver,
            uint64 branchExpiry, address admin, OrgRegistrar org, bytes32 branchNode)
```

Immutables bound: `REGISTRY`, `RESOLVER`, `BRANCH_EXPIRY`, `ORG`, `BRANCH_NODE`. The constructor grants `admin` all root verb roles. `REQUIRED_REGISTRY_ROLES = ROLE_REGISTRAR | ROLE_RENEW | ROLE_UNREGISTER`. Resolver text grant = `uint256(1) << 4` (`ROLE_SET_TEXT`).

### Write function signatures (absent from the read-only ABIs)

- `onboard(string label, address owner, bytes32 role, string memberLabel) → uint256`
- `setOwnRecord(string key, string value, bytes32 node)`
- `defineRole(string name, uint256 registryBitmap, bool canOnboard, bool openToOnboarders, string[] editableKeys, (string key, string value)[] grants)`
- `revoke(uint256 anyId)`
- `setRecord(uint256 resource, string key, string value, bytes32 node)` (staff-only)

### Branch-creation sequence (the real order, from AddBranch.s.sol)

1. `branchRegistry = new PermissionedRegistry(LABEL_STORE, admin, ALL_ROLES)`
2. `orgRegistry.register(label, admin, branchRegistry, resolver, 0, expiry)`
3. `branchRegistry.setParent(orgRegistry, label)`
4. `registrar = new BranchRegistrarV2(branchRegistry, resolver, expiry, admin, orgRegistrar, branchNode)`
5. `branchRegistry.grantRootRoles(registrar.REQUIRED_REGISTRY_ROLES(), registrar)`
6. `orgRegistrar.grantRootRoles(ROLE_ENROL, registrar)`
7. `resolver.grantRootRoles(1 << 4, registrar)`
8. `resolver.setText(branchNode, "ensca.registrar", registrarAddress)` — **NEW, load-bearing**

`branchNode = namehash(label + "." + org)`, computed per branch (AddBranch currently hardcodes it).

### Discovery-record gap (load-bearing)

No current script writes the `ensca.registrar` text record; it exists only as a doc-comment in `web/lib/ens/indexer.ts`. But branch discovery depends on it: the indexer reads `text(key: "ensca.registrar")` to learn a branch's registrar address. Without it a dynamic branch is invisible to the console (the chain fallback only reads the single default branch). Step 8 above closes this, and the deploy script must write it for the default branch too.

### Submodule blocker

`contracts/lib/contracts-v2/` is empty in this worktree (submodule not initialized). `forge build` fails until `git submodule update --init --recursive` pulls it and its nested deps. solc 0.8.30, optimizer 200, via_ir off.

## Delivery: Six Phases

### Phase 1 — Compile

Initialize the `@ens-v2` submodule recursively; `forge build` green. No Solidity written. Deliverable: clean build.

### Phase 2 — Deploy onto owned name

Adapt `DeployV2.s.sol`: read the owned org name's registry state, confirm the deployer key owns it, stand up org registry (`setSubregistry` / `setParent`), deploy resolver proxy (`setResolver`), deploy `OrgRegistrar` + a default `BranchRegistrarV2`, grant `REQUIRED_REGISTRY_ROLES` + `ROLE_ENROL` + resolver `ROLE_SET_TEXT`, write the default branch's `ensca.registrar` record, run SeedRoles (hacker / volunteer / mentor). Rewrite `contracts/deployments/sepolia.json`.

**Invariant tests (forge, local, no network):** deploy the stack in `setUp()`; assert (a) a hacker wallet reverts on `onboard` and `setOwnRecord`; (b) a volunteer onboards a hacker successfully; (c) a mentor edits `avatar` but reverts on a non-`selfEditable` key.

### Phase 3 — Config + read-layer sync

Update `web/lib/ens/config.ts` to the new addresses + `fromBlock` (the new registrar's deploy block), in the same commit as `sepolia.json`. Add a read-layer field exposing each role's `selfEditable` key set (needed by the UI edit gate; not currently returned by `getRoles()`), with its own test. No other read logic changes — discovery is address-agnostic.

### Phase 4 — Wallet connection + write ABIs

Add wagmi + viem + WalletConnect connector (`NEXT_PUBLIC_WC_PROJECT_ID` env). Client provider tree (`WagmiProvider` + `QueryClientProvider`) wrapping the console; server read routes untouched. New `web/lib/ens/write-abis.ts` (the write signatures above) kept out of the server bundle. New `POST /api/ens/*/simulate` route(s): server `simulateContract` pre-check, returns `{ok}` or `{ok:false, reason}`, holds no key. Tests: ABI encoding, simulate route (mocked client), wagmi config shape.

### Phase 5 — UI wiring to the invariant

- **Role catalogue is the only source of truth:** delete the hardcoded `RoleName` union and `TIER_ROLE` map; drive dropdowns/chips/gating from `RoleInfo`.
- **Client role gate:** read the connected wallet's `effectiveRole`; render write controls only where the role can act (convenience — contract still enforces).
- **Onboard flow:** the dead "Onboard member" button becomes a modal (role filtered by mintability + label/owner/memberLabel) → simulate → sign `onboard` → revalidate. A hacker wallet sees no mintable roles.
- **Self-edit flow:** edit control shown only for keys in the role's `selfEditable` set (hacker → none). → simulate → sign `setOwnRecord`.
- **Dynamic branch creation (staff):** the 8-step sequence above, signed in order, with a **resumable step sequencer** keyed off on-chain state (registry exists? name registered? registrar deployed? roles granted? text record written?), so a mid-sequence failure resumes rather than orphaning a registry or re-registering a name.

Before writing any web code, read `node_modules/next/dist/docs/` (Next 16, per `web/AGENTS.md`). Tests: role-filter logic (hacker → empty), self-edit gate (hacker → none / mentor → avatar+ssh.pubkey), branch-create resume-point computation.

### Phase 6 — Live end-to-end verification (includes the funded multi-wallet test)

Runs on live Sepolia against the fresh deploy.

- **Deploy verification:** on-chain confirm org/resolver/registrar wiring and seeded roles; Etherscan-verify; confirm `sepolia.json` ↔ `config.ts` match.
- **Read verification:** `/api/ens/branch` + `/api/ens/memberships`; confirm `source` (indexer vs chain) and that roles/entitlements/`selfEditable` resolve.
- **Invariant proof (real wallets, funded from the deploy key):** create test wallets, fund with Sepolia ETH; hacker wallet — no mintable roles, forced `onboard` reverts, no editable keys, forced `setOwnRecord` reverts `CannotEditKey`; volunteer onboards a hacker (succeeds); mentor edits `avatar` (succeeds) but reverts on `role`. Record tx hashes — these are the evidence.
- **Full flows:** staff onboard a member (appears after revalidate, entitlement texts resolve); staff create a dynamic branch (8 steps land, `ensca.registrar` written, branch discovered or documented as pending indexer catch-up); mentor self-edits `avatar` from the browser.
- **Browser check:** `next dev`, connect a wallet, exercise every flow + watch for regressions in read-only views. If live signing can't be fully exercised, say so rather than claim success.

## Open Item

- `organization`: the org `.eth` name the deployer key owns. **`<ORG_NAME>` — to be provided at review.** Fills the `organization` field in `sepolia.json` + `config.ts`; the deploy reads the owned name's registry state from it.

## Non-Goals

- No commit-reveal `.eth` registration (the name is pre-owned).
- No server-held signing key; no server write path.
- No change to the read-only console views beyond address/config sync and the `selfEditable` field.
- No V1 (`BranchRegistrar`) changes; V1 is superseded.
