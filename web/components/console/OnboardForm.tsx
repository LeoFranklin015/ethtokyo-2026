"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useEnsBranches } from "@/lib/hooks/useEns";
import type { RoleInfo } from "@/lib/ens/read";

/**
 * Onboarding someone.
 *
 * One transaction mints the membership, assigns its group, and writes the group's entitlements —
 * so the name is resolvable and the network will admit them the moment it confirms. On a first
 * visit anywhere in the organization it also mints their Member name, which is what carries their
 * identity to other branches.
 */
export function OnboardForm({ onDone }: { onDone?: () => void }) {
  const { branches } = useEnsBranches();
  const withRegistrar = (branches ?? []).filter((b) => b.registrar);

  const [registrar, setRegistrar] = useState("");
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [free, setFree] = useState<boolean | null>(null);

  const branch = withRegistrar.find((b) => b.registrar === registrar) ?? withRegistrar[0];
  const target = branch?.registrar ?? "";

  const { data: groupData } = useSWR<{ groups: RoleInfo[] }>(
    target ? `groups:${target}` : null,
    () => fetch(`/api/ens/groups?registrar=${target}`).then((r) => r.json()),
  );
  const groups = (groupData?.groups ?? []).filter((g) => g.active);

  useEffect(() => {
    if (!group && groups.length) setGroup(groups[0].name);
  }, [groups, group]);

  // Is this label still free inside the chosen branch?
  useEffect(() => {
    const value = label.trim().toLowerCase();
    if (!value || !branch) {
      setFree(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/ens/available?label=${encodeURIComponent(value)}&registry=${branch.registry}`,
        );
        const body = await res.json();
        setFree(body.valid ? body.available : false);
      } catch {
        setFree(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [label, branch]);

  const validAddress = /^0x[0-9a-fA-F]{40}$/.test(owner.trim());
  const canSubmit = Boolean(target && label && validAddress && group && free && !busy);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/ens/onboard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ registrar: target, label, owner: owner.trim(), group }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed");
      setMessage({
        ok: true,
        text: `${label}.${branch?.name} is live, in group “${group}”.`,
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
          <span className="label">Branch</span>
          <select
            value={target}
            onChange={(e) => setRegistrar(e.target.value)}
            className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink"
          >
            {withRegistrar.length === 0 ? <option value="">no branches yet</option> : null}
            {withRegistrar.map((b) => (
              <option key={b.name} value={b.registrar ?? ""}>
                {b.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="label">Name</span>
          <span className="mt-2 flex items-center gap-2">
            <input
              value={label}
              onChange={(e) =>
                setLabel(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase())
              }
              placeholder="leo"
              autoComplete="off"
              className="h-11 min-w-0 flex-1 rounded-sharp border border-rule bg-paper px-3 font-mono text-sm text-ink placeholder:text-ink-faint"
            />
            <span className="shrink-0 truncate font-mono text-xs text-ink-muted">
              .{branch?.name ?? "…"}
            </span>
          </span>
          <span className="mt-1 block min-h-[1rem] font-mono text-[0.6875rem]" role="status">
            {free === true ? (
              <span style={{ color: "var(--signal)" }}>available</span>
            ) : free === false ? (
              <span style={{ color: "var(--alert)" }}>already taken in this branch</span>
            ) : null}
          </span>
        </label>

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
            value={group}
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
            {groups.find((g) => g.name === group)?.entitlements.length
              ? groups
                  .find((g) => g.name === group)!
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
      </div>
    </Panel>
  );
}
