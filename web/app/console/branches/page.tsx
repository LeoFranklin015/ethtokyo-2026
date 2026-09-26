"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { PageHeader } from "@/components/console/PageHeader";
import { EnsBranches } from "@/components/console/EnsBranches";
import { NoOrgSelected } from "@/components/console/OrgPicker";
import { useOrg } from "@/lib/hooks/useOrg";
import { Button } from "@/components/ui/Button";
import { useEnsWrites } from "@/lib/ens/useEnsWrites";
import { useAccount } from "wagmi";
import type { Address } from "viem";

export default function BranchesPage() {
  const org = useOrg();
  const { mutate: globalMutate } = useSWRConfig();
  const [showCreate, setShowCreate] = useState(false);

  if (!org) return <NoOrgSelected />;

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Perimeters"
        meta={`Names under ${org}.eth that carry a registry of their own`}
        actions={
          <Button variant="outline" onClick={() => setShowCreate(true)}>
            Create perimeter
          </Button>
        }
      />
      <div className="px-5 py-6 lg:px-8">
        <EnsBranches org={org} />
      </div>

      {showCreate ? (
        <CreatePerimeterModal
          org={org}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void globalMutate(`ens-branches:${org}`);
          }}
        />
      ) : null}
    </>
  );
}

function CreatePerimeterModal({
  org,
  onClose,
  onCreated,
}: {
  org: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { address } = useAccount();
  const writes = useEnsWrites();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: orgData } = useSWR<{ organization: { branchFactory: string } | null }>(
    `org-meta:${org}`,
    async () => {
      const r = await fetch(`/api/ens/org?name=${encodeURIComponent(org)}`);
      if (!r.ok) throw new Error("could not read org");
      return r.json();
    },
  );
  const factory = orgData?.organization?.branchFactory ?? null;

  const clean = label.trim().toLowerCase();
  const validLabel = /^[a-z0-9-]{1,32}$/.test(clean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factory || !address || !validLabel) return;
    setBusy(true);
    setError(null);
    try {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
      const created = await writes.createBranch(
        clean,
        expiry,
        address as Address,
        factory as Address,
        org,
      );
      if (!created) throw new Error(writes.error ?? "the transaction did not go through");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/20"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create perimeter"
        className="relative w-full max-w-[440px] rounded-sharp border border-rule bg-paper p-5"
      >
        <p className="label">New perimeter</p>
        <h2 className="mt-1 font-mono text-sm text-ink">{org}.eth</h2>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          A perimeter is a branch registry. Give it a short identifier — members will be onboarded
          under it as <span className="font-mono">&lt;badge&gt;.&lt;name&gt;.{org}.eth</span>.
        </p>

        <form onSubmit={(e) => { void submit(e); }} className="mt-4 space-y-4">
          <label className="block">
            <span className="label">Perimeter name</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. tokyo"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="mt-2 h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink placeholder:text-ink-faint"
            />
            {label && !validLabel ? (
              <span className="mt-1 block text-xs" style={{ color: "var(--alert)" }}>
                Lowercase letters, digits and hyphens only, 1–32 characters.
              </span>
            ) : label && validLabel ? (
              <span className="mt-1 block font-mono text-xs text-ink-muted">
                {clean}.{org}.eth
              </span>
            ) : null}
          </label>

          {error ? (
            <p className="text-xs" style={{ color: "var(--alert)" }} role="status">
              {error}
            </p>
          ) : null}

          {!address ? (
            <p className="text-xs text-ink-muted">Connect a wallet to sign the transaction.</p>
          ) : !factory ? (
            <p className="text-xs text-ink-muted">Reading org contracts…</p>
          ) : null}

          <div className="flex gap-2">
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !validLabel || !factory || !address}
            >
              {busy ? "Creating…" : "Create"}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
