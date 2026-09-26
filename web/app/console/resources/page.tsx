"use client";

import { useState } from "react";
import { PageHeader } from "@/components/console/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ApiError, api } from "@/lib/api";
import { useResources, type Resource } from "@/lib/hooks/useEnforcer";

/**
 * The upstreams this branch proxies to, and how it authenticates to each.
 *
 * Resources are deliberately local: an upstream URL and an API key are never published to ENS
 * and never should be. The chain says which group somebody is in; this says what that group can
 * reach and with whose credentials.
 */

const PLACEMENTS = [
  { value: "url_path", label: "In the path", hint: "{base}/{key}/{subpath}", extra: null },
  { value: "header", label: "Custom header", hint: "Name: key", extra: "key_header_name" },
  { value: "bearer_token", label: "Bearer token", hint: "Authorization: Bearer {key}", extra: null },
  { value: "basic_auth", label: "Basic auth", hint: "base64(user:key)", extra: "api_key_b64_user" },
  { value: "query_param", label: "Query parameter", hint: "?name={key}", extra: "query_param_name" },
  { value: "no_auth", label: "No authentication", hint: "nothing injected", extra: null },
] as const;

export default function ResourcesPage() {
  const { resources, error, isLoading, reload } = useResources();
  const [adding, setAdding] = useState(false);

  const signedOut = error instanceof ApiError && error.isUnauthenticated;

  return (
    <>
      <PageHeader
        eyebrow="Enforcer"
        title="Resources"
        meta="Upstreams this perimeter proxies to"
        actions={
          <Button variant="solid" onClick={() => setAdding((a) => !a)}>
            {adding ? "Cancel" : "Add a resource"}
          </Button>
        }
      />

      <div className="space-y-6 px-4 py-6 sm:px-6">
        <p className="max-w-[62ch] text-sm leading-relaxed text-ink-muted">
          A resource is an upstream service and the credential the enforcer uses to reach it.
          Access is granted per group, never per person — see{" "}
          <a href="/console/access" className="underline decoration-rule underline-offset-2">
            Access
          </a>
          .
        </p>

        {adding ? <ResourceForm onDone={() => { setAdding(false); void reload(); }} /> : null}

        <Panel as="section">
          <PanelHeader
            right={
              resources ? (
                <span className="font-mono text-[0.6875rem] text-ink-muted">
                  {resources.length}
                </span>
              ) : null
            }
          >
            All resources
          </PanelHeader>

          {signedOut ? (
            <Failed>
This wallet has not proved it owns the organization, so nothing here can be
              changed.{" "}
              <a href="/console/signin" className="underline decoration-rule underline-offset-2">
                Sign a message to prove it
              </a>
              .
            </Failed>
          ) : error ? (
            <Failed>
              The enforcer did not answer. Nothing is listed rather than listing nothing.
            </Failed>
          ) : isLoading && !resources ? (
            <p className="px-4 py-8 font-mono text-xs text-ink-muted">Reading…</p>
          ) : (resources ?? []).length === 0 ? (
            <p className="px-4 py-8 text-sm text-ink-muted">
              No resources yet. Add one and no group can reach anything until you grant it.
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {(resources ?? []).map((r) => (
                <ResourceRow key={r.id} resource={r} onChanged={() => void reload()} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function ResourceRow({ resource, onChanged }: { resource: Resource; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: resource.enabled ? "var(--signal)" : "var(--ink-faint)" }}
            />
            <span className="truncate font-mono text-sm text-ink">{resource.slug}</span>
            {resource.has_pending_key ? (
              <span
                className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.625rem]"
                style={{ borderColor: "var(--alert)", color: "var(--alert)" }}
              >
                key staged
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-ink-muted">
            {hostOf(resource.upstream_url)} · {resource.key_placement}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "close" : "manage"}
          </Button>
        </span>
      </div>

      {open ? (
        <div className="mt-3 space-y-3 rounded-sharp border border-rule px-4 py-3">
          <dl className="space-y-1">
            <Detail term="upstream" value={resource.upstream_url} />
            <Detail term="display name" value={resource.display_name} />
            {resource.key_header_name ? (
              <Detail term="header" value={resource.key_header_name} />
            ) : null}
            {resource.query_param_name ? (
              <Detail term="query param" value={resource.query_param_name} />
            ) : null}
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => act(() => api.patch(`resources/${resource.id}`, { enabled: !resource.enabled }))}
            >
              {resource.enabled ? "Disable" : "Enable"}
            </Button>

            {resource.has_pending_key ? (
              <>
                <Button
                  variant="solid"
                  disabled={busy}
                  onClick={() => act(() => api.post(`resources/${resource.id}/commit-key`))}
                >
                  Activate staged key
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act(() => api.delete(`resources/${resource.id}/pending-key`))}
                >
                  Discard it
                </Button>
              </>
            ) : (
              <RotateKey id={resource.id} onDone={onChanged} />
            )}

            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => act(() => api.delete(`resources/${resource.id}`))}
            >
              Delete
            </Button>
          </div>

          {resource.has_pending_key ? (
            <p className="text-xs leading-relaxed text-ink-muted">
              A new key is staged but not in use. Requests still go out with the old one until you
              activate it.
            </p>
          ) : null}

          {message ? (
            <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Staging a key does not activate it — that is the whole point of the two steps. */
function RotateKey({ id, onDone }: { id: string; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <span className="flex items-center gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        type="password"
        placeholder="new key"
        autoComplete="off"
        className="h-11 w-[160px] rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink placeholder:text-ink-faint"
      />
      <Button
        variant="outline"
        disabled={!value.trim() || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.patch(`resources/${id}/rotate-key`, { new_key: value.trim() });
            setValue("");
            onDone();
          } finally {
            setBusy(false);
          }
        }}
      >
        Stage key
      </Button>
    </span>
  );
}

function ResourceForm({ onDone }: { onDone: () => void }) {
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [upstream, setUpstream] = useState("");
  const [placement, setPlacement] = useState<string>("bearer_token");
  const [apiKey, setApiKey] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const spec = PLACEMENTS.find((p) => p.value === placement)!;
  const needsKey = placement !== "no_auth";
  const valid =
    /^[a-z0-9-]{1,64}$/.test(slug) &&
    upstream.trim().startsWith("http") &&
    (!needsKey || apiKey.trim()) &&
    (!spec.extra || extra.trim() || placement === "basic_auth");

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      await api.post("resources", {
        slug: slug.trim(),
        display_name: displayName.trim() || slug.trim(),
        upstream_url: upstream.trim(),
        key_placement: placement,
        // Omitted entirely for `no_auth`: sending an explicit null makes the enforcer 500 on
        // `None.strip()`.
        ...(needsKey ? { api_key: apiKey.trim() } : {}),
        ...(spec.extra === "key_header_name" ? { key_header_name: extra.trim() } : {}),
        ...(spec.extra === "query_param_name" ? { query_param_name: extra.trim() } : {}),
        ...(spec.extra === "api_key_b64_user" ? { api_key_b64_user: extra.trim() } : {}),
        enabled: true,
      });
      onDone();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel as="section">
      <PanelHeader>Add a resource</PanelHeader>
      <div className="space-y-4 px-4 py-5">
        <Field label="Slug" hint="What the proxy path uses: /proxy/<slug>. Cannot be changed later.">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase())}
            placeholder="alchemy-sepolia"
            autoComplete="off"
            className="h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-sm text-ink placeholder:text-ink-faint"
          />
        </Field>

        <Field label="Display name">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Alchemy Sepolia RPC"
            autoComplete="off"
            className="h-11 w-full rounded-sharp border border-rule bg-paper px-3 text-sm text-ink placeholder:text-ink-faint"
          />
        </Field>

        <Field label="Upstream URL">
          <input
            value={upstream}
            onChange={(e) => setUpstream(e.target.value)}
            placeholder="https://eth-sepolia.g.alchemy.com/v2"
            autoComplete="off"
            spellCheck={false}
            className="h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink placeholder:text-ink-faint"
          />
        </Field>

        <Field label="How the key is sent" hint={spec.hint}>
          <select
            value={placement}
            onChange={(e) => {
              setPlacement(e.target.value);
              setExtra("");
            }}
            className="h-11 w-full rounded-sharp border border-rule bg-paper px-2 font-mono text-xs text-ink"
          >
            {PLACEMENTS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        {spec.extra ? (
          <Field
            label={
              spec.extra === "key_header_name"
                ? "Header name"
                : spec.extra === "query_param_name"
                  ? "Query parameter name"
                  : "Basic auth username"
            }
            hint={spec.extra === "api_key_b64_user" ? "May be empty." : undefined}
          >
            <input
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              autoComplete="off"
              className="h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink"
            />
          </Field>
        ) : null}

        {needsKey ? (
          <Field label="API key" hint="Stored by the enforcer. The console never reads it back.">
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              autoComplete="off"
              className="h-11 w-full rounded-sharp border border-rule bg-paper px-3 font-mono text-xs text-ink"
            />
          </Field>
        ) : null}

        {message ? (
          <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
            {message}
          </p>
        ) : null}

        <Button variant="solid" onClick={submit} disabled={!valid || busy}>
          {busy ? "Adding…" : "Add resource"}
        </Button>
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

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="font-mono text-[0.6875rem] text-ink-muted">{term}</dt>
      <dd className="truncate font-mono text-[0.6875rem] text-ink-80">{value}</dd>
    </div>
  );
}

function Failed({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-8 text-xs leading-relaxed" style={{ color: "var(--alert)" }} role="status">
      {children}
    </p>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
