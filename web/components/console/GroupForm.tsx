"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useEnsBranches } from "@/lib/hooks/useEns";
import { useEnsWrites } from "@/lib/ens/useEnsWrites";
import { useAccount } from "wagmi";
import type { Address } from "viem";

type Row = { key: string; value: string };

const STARTER_ENTITLEMENTS: Row[] = [
  { key: "wifi.group", value: "" },
  { key: "wifi.rate", value: "" },
  { key: "wifi.ceil", value: "" },
];

/**
 * Defining a group.
 *
 * A group mints no name. It is a category stored in the branch registrar, which onboarding then
 * assigns to a person — so the entitlements set here are written onto every membership in the
 * group, and redefining a group changes what its existing members get without touching them
 * one by one.
 */
export function GroupForm({ onDone }: { onDone?: () => void }) {
  const { branches, isLoading: branchesLoading } = useEnsBranches();
  const withRegistrar = (branches ?? []).filter((b) => b.registrar);

  const [registrar, setRegistrar] = useState("");
  const [name, setName] = useState("");
  const [canOnboard, setCanOnboard] = useState(false);
  const [openToOnboarders, setOpenToOnboarders] = useState(true);
  const [editableKeys, setEditableKeys] = useState("");
  const [rows, setRows] = useState<Row[]>(STARTER_ENTITLEMENTS);
  const { address } = useAccount();
  const writes = useEnsWrites();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const target = registrar || withRegistrar[0]?.registrar || "";
  const valid = /^[a-z0-9-]{1,32}$/.test(name) && Boolean(target) && Boolean(address);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      // Signed by whoever is connected. The registrar checks `ROLE_ROLE_EDIT` itself, so a
      // wallet without it is refused by the chain rather than by us.
      const written = await writes.defineGroup({
        registrar: target as Address,
        name: name.trim().toLowerCase(),
        canOnboard,
        openToOnboarders,
        editableKeys: editableKeys
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        entitlements: rows.filter((r) => r.key && r.value),
      });
      if (!written) throw new Error(writes.error ?? "the transaction did not go through");

      // Now ask the server to copy it into the enforcer. It re-reads the chain before writing,
      // so this is a request to verify-and-copy, not a claim it has to believe.
      const res = await fetch("/api/ens/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "group", registrar: target, name: name.trim().toLowerCase() }),
      });
      const body = await res.json();
      setMessage({
        ok: true,
        text: body.mirrored
          ? `Group “${name}” is defined on-chain and known to the enforcer.`
          : `Group “${name}” is defined on-chain, but the enforcer was not updated (${body.reason ?? "unknown"}). Members of this group will be denied the network until it is.`,
      });
      setName("");
      onDone?.();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel as="section">
      <PanelHeader>Define a group</PanelHeader>
      <div className="space-y-4 px-4 py-5">
        <Field label="Branch">
          <select
            value={target}
            onChange={(e) => setRegistrar(e.target.value)}
            className="h-11 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink"
          >
            {withRegistrar.length === 0 ? (
              <option value="">{branchesLoading ? "discovering…" : "no branches yet"}</option>
            ) : null}
            {withRegistrar.map((b) => (
              <option key={b.name} value={b.registrar ?? ""}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Group name" hint="A category of people — hacker, mentor, staff. Mints nothing.">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase())}
            placeholder="mentor"
            autoComplete="off"
            className="h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-sm text-ink placeholder:text-ink-faint"
          />
        </Field>

        <fieldset className="space-y-2">
          <legend className="label">Permissions</legend>
          <Check
            checked={openToOnboarders}
            onChange={setOpenToOnboarders}
            label="Any onboarder may assign this group"
            hint="Off means only accounts delegated for this specific group can assign it."
          />
          <Check
            checked={canOnboard}
            onChange={setCanOnboard}
            label="Members of this group may onboard others"
            hint="They can assign open groups only — never one above their own."
          />
        </fieldset>

        <Field
          label="Self-editable records"
          hint="Comma-separated keys a member may write on their own name. Leave empty for none."
        >
          <input
            value={editableKeys}
            onChange={(e) => setEditableKeys(e.target.value)}
            placeholder="avatar, ssh.pubkey"
            autoComplete="off"
            className="h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink placeholder:text-ink-faint"
          />
        </Field>

        <fieldset>
          <legend className="label">Entitlements written to every member</legend>
          <div className="mt-2 space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={row.key}
                  onChange={(e) =>
                    setRows(rows.map((r, j) => (i === j ? { ...r, key: e.target.value } : r)))
                  }
                  placeholder="key"
                  aria-label={`Entitlement key ${i + 1}`}
                  className="h-10 w-2/5 rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink placeholder:text-ink-faint"
                />
                <input
                  value={row.value}
                  onChange={(e) =>
                    setRows(rows.map((r, j) => (i === j ? { ...r, value: e.target.value } : r)))
                  }
                  placeholder="value"
                  aria-label={`Entitlement value ${i + 1}`}
                  className="h-10 min-w-0 flex-1 rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink placeholder:text-ink-faint"
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setRows([...rows, { key: "", value: "" }])}
            className="mt-2 font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
          >
            add another
          </button>
        </fieldset>

        {message ? (
          <p
            className="text-xs leading-relaxed"
            style={{ color: message.ok ? "var(--ink-muted)" : "var(--alert)" }}
            role="status"
          >
            {message.text}
          </p>
        ) : null}

        <Button variant="solid" onClick={submit} disabled={!valid || busy}>
          {busy ? "Defining…" : "Define group"}
        </Button>
        {!address ? (
          <p className="text-xs text-ink-muted">
            Connect the wallet that owns this branch — it signs the transaction, and the
            registrar checks its roles on chain.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <span className="mt-2 block">{children}</span>
      {hint ? <span className="mt-1 block text-xs text-ink-muted">{hint}</span> : null}
    </label>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--ink)]"
      />
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        <span className="block text-xs leading-relaxed text-ink-muted">{hint}</span>
      </span>
    </label>
  );
}
