"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { QrScanner } from "@/components/QrScanner";
import { useEnsBranches } from "@/lib/hooks/useEns";
import { useEnsWrites } from "@/lib/ens/useEnsWrites";
import { useAccount } from "wagmi";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { RoleInfo } from "@/lib/ens/read";

/**
 * Onboarding someone.
 *
 * One transaction mints the membership, assigns its group, and writes the group's entitlements —
 * so the name is resolvable and the network will admit them the moment it confirms. On a first
 * visit anywhere in the organization it also mints their Member name, which is what carries their
 * identity to other branches.
 */
export function OnboardForm({ org, onDone }: { org: string; onDone?: () => void }) {
  const { branches, isLoading: branchesLoading } = useEnsBranches(org);
  const withRegistrar = (branches ?? []).filter((b) => b.registrar);

  const [registrar, setRegistrar] = useState("");
  // Read off the member's badge rather than typed: the label is their five-character id.
  const [label, setLabel] = useState("");
  const [scanning, setScanning] = useState(false);
  const [owner, setOwner] = useState("");
  const [group, setGroup] = useState("");
  // Derived rather than synced from an effect: the first group is the default until one is picked.
  const { address } = useAccount();
  const writes = useEnsWrites();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [free, setFree] = useState<boolean | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  // Separate from `free`, because it is a different registry answering a different question.
  const [nameBlocked, setNameBlocked] = useState(false);

  const branch = withRegistrar.find((b) => b.registrar === registrar) ?? withRegistrar[0];
  const target = branch?.registrar ?? "";
  const validAddress = /^0x[0-9a-fA-F]{40}$/.test(owner.trim());

  const { data: groupData } = useSWR<{ groups: RoleInfo[] }>(
    target ? `groups:${target}` : null,
    async () => {
      const r = await fetch(`/api/ens/groups?registrar=${target}`);
      if (!r.ok) throw new Error(`group list unavailable (${r.status})`);
      return r.json();
    },
  );
  const groups = (groupData?.groups ?? []).filter((g) => g.active);
  const selectedGroup = group || groups[0]?.name || "";

  // Is this label still free inside the chosen branch?
  useEffect(() => {
    const value = label.trim().toLowerCase();
    if (!value || !branch) return;

    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/ens/available?label=${encodeURIComponent(value)}&registry=${branch.registry}`,
        );
        // A 502 is the chain being unreachable, not a name being taken. Rendering it as "taken"
        // would lock the operator out of onboarding for the duration of an RPC blip.
        if (!res.ok) {
          setFree(null);
          setCheckFailed(true);
          return;
        }
        const body = await res.json();
        setCheckFailed(false);
        setFree(body.valid ? body.available : false);

        // The same id is minted as their organization-wide Member name, in a registry that also
        // holds every branch name. An id equal to a branch label reverts the whole transaction
        // after signing, so it has to be caught here rather than discovered in the wallet.
        if (!org || !validAddress) return;
        const claim = await fetch(
          `/api/ens/member-name?org=${encodeURIComponent(org)}&id=${encodeURIComponent(value)}` +
            `&wallet=${owner.trim()}`,
        );
        setNameBlocked(claim.ok ? Boolean((await claim.json()).blocked) : false);
      } catch {
        setFree(null);
        setCheckFailed(true);
      }
    }, 350);
    return () => clearTimeout(t);
    // `branch` itself is a fresh object on every SWR revalidation; depending on it re-fired
    // this check every 60s on an untouched form. The registry address is what actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, branch?.registry, org, owner, validAddress]);

  const canSubmit = Boolean(
    target && label && validAddress && selectedGroup && free && !nameBlocked && address && !busy,
  );

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      // Signed by whoever is connected. The registrar decides whether they may mint this role —
      // including the derived path, so a volunteer onboarding a hacker works here unchanged.
      const written = await writes.onboard({
        registrar: target as Address,
        label,
        owner: owner.trim() as Address,
        roleId: keccak256(toHex(selectedGroup)) as Hex,
        // Their organization-wide Member name is the badge id too. It used to be a second,
        // typed field, which meant one person could be `a1b2c` at the branch and something else
        // org-wide — and the portal, which has only the badge to go on, could not find them.
        memberLabel: label,
      });
      if (!written) throw new Error(writes.error ?? "the transaction did not go through");

      const res = await fetch("/api/ens/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "member",
          org,
          registrar: target,
          label,
          wallet: owner.trim(),
        }),
      });
      const body = await res.json();
      setMessage({
        ok: true,
        text: body.mirrored
          ? `${label}.${branch?.name} is live, in group “${selectedGroup}”.`
          : `${label}.${branch?.name} is minted on ENS, but the enforcer was not updated (${body.reason ?? "unknown"}). They will not be admitted to the network until it is.`,
      });
      setLabel("");
      setOwner("");
      onDone?.();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel as="section">
      <PanelHeader>Onboard a member</PanelHeader>
      <div className="space-y-4 px-4 py-5">
        <label className="block">
          <span className="label">Perimeter</span>
          <select
            value={target}
            onChange={(e) => setRegistrar(e.target.value)}
            className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink"
          >
            {withRegistrar.length === 0 ? (
              <option value="">{branchesLoading ? "discovering…" : "no perimeters yet"}</option>
            ) : null}
            {withRegistrar.map((b) => (
              <option key={b.name} value={b.registrar ?? ""}>
                {b.label}
              </option>
            ))}
          </select>
        </label>

        <div className="block">
          <span className="label">Name</span>
          {label ? (
            <span className="mt-2 flex items-center gap-2">
              <span className="flex h-11 min-w-0 flex-1 items-center rounded-sharp border border-rule bg-paper px-3 font-mono text-sm text-ink">
                <span className="tracking-[0.2em]">{label}</span>
                <span className="ml-1 truncate text-ink-muted">.{branch?.name ?? "…"}</span>
              </span>
              <Button
                variant="ghost"
                className="shrink-0"
                onClick={() => setScanning(true)}
                disabled={busy}
              >
                Rescan
              </Button>
            </span>
          ) : (
            <span className="mt-2 block">
              <Button variant="outline" onClick={() => setScanning(true)} disabled={busy}>
                Scan badge
              </Button>
            </span>
          )}
          <span className="mt-1 block min-h-[1rem] font-mono text-[0.6875rem]" role="status">
            {checkFailed ? (
              <span style={{ color: "var(--alert)" }}>
                could not check — the chain did not answer
              </span>
            ) : free === true ? (
              <span style={{ color: "var(--signal)" }}>available</span>
            ) : free === false ? (
              <span style={{ color: "var(--alert)" }}>already taken in this perimeter</span>
            ) : nameBlocked ? (
              <span style={{ color: "var(--alert)" }}>
                already an organization name — this badge cannot be minted
              </span>
            ) : label ? null : (
              <span className="text-ink-muted">their id comes from the badge they were given</span>
            )}
          </span>
          {label ? (
            <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
              The badge id is also minted as their organization-wide name, so the portal can find
              them from the same scan.
            </span>
          ) : null}
        </div>

        <label className="block">
          <span className="label">Wallet</span>
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink placeholder:text-ink-faint"
          />
          <span className="mt-1 block min-h-[1rem] text-xs text-ink-muted">
            {owner && !validAddress ? "That is not a wallet address." : "They will own the name."}
          </span>
        </label>

        <label className="block">
          <span className="label">Group</span>
          <select
            value={selectedGroup}
            onChange={(e) => setGroup(e.target.value)}
            className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink"
          >
            {groups.length === 0 ? <option value="">no groups defined yet</option> : null}
            {groups.map((g) => (
              <option key={g.id} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-ink-muted">
            {groups.find((g) => g.name === selectedGroup)?.entitlements.length
              ? groups
                  .find((g) => g.name === selectedGroup)!
                  .entitlements.map((e) => `${e.key}=${e.value}`)
                  .join(" · ")
              : "This group publishes no entitlements."}
          </span>
        </label>

        {message ? (
          <p
            className="text-xs leading-relaxed"
            style={{ color: message.ok ? "var(--ink-muted)" : "var(--alert)" }}
            role="status"
          >
            {message.text}
          </p>
        ) : null}

        <Button variant="solid" onClick={submit} disabled={!canSubmit}>
          {busy ? "Onboarding…" : "Onboard"}
        </Button>
        {scanning ? (
          <QrScanner
            onScanned={(id) => {
              setLabel(id);
              setFree(null);
              setCheckFailed(false);
              setScanning(false);
            }}
            onClose={() => setScanning(false)}
          />
        ) : null}

        {!address ? (
          <p className="text-xs text-ink-muted">
            Connect a wallet that may onboard into this group — perimeter staff, or a member of a
            group the organization marked as able to onboard others.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
