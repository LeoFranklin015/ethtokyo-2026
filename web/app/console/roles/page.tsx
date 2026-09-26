import { PageHeader } from "@/components/console/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SourceTag } from "@/components/ui/SourceTag";
import { getBranch, getPermissionHolders, getRoleCatalogue } from "@/lib/ens/branch";
import { DEPLOYMENT, explorer } from "@/lib/ens/config";
import type { Address } from "viem";

export const metadata = { title: "Roles — ENSCA console" };
export const revalidate = 30;

/** Accounts worth showing on the permissions board. */
const WATCHED: { label: string; account: Address }[] = [
  { label: "organizer", account: "0xE08224B2CfaF4f27E2DC7cB3f6B99AcC68Cf06c0" },
  { label: "volunteer", account: "0xD3b01908f30Cf733d45869d0ed5Dd9160BB514d9" },
];

function Yes({ on }: { on: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ background: on ? "var(--signal)" : "var(--ink-faint)" }}
      />
      <span className={on ? "text-ink-80" : "text-ink-muted"}>{on ? "granted" : "—"}</span>
    </span>
  );
}

export default async function RolesPage() {
  const [branch, catalogue, holders] = await Promise.all([
    getBranch(),
    getRoleCatalogue(),
    getPermissionHolders(WATCHED.map((w) => w.account)),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Branch"
        title="Role catalogue"
        meta={`As the deployed registrar defines it, for ${branch.branch}`}
        actions={<SourceTag source="chain" />}
      />

      <div className="grid gap-6 px-5 py-6 lg:px-8 xl:grid-cols-2">
        {/* Entitlements: what a role grants over its own name, read from the contract */}
        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={
              <a
                href={explorer(DEPLOYMENT.branchRegistrar)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
              >
                registryBitmapFor()
              </a>
            }
          >
            Registry roles per membership
          </PanelHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] border-collapse text-left">
              <caption className="sr-only">
                Registry role bitmap each role grants the holder over their own name
              </caption>
              <thead>
                <tr className="border-b border-rule">
                  {["Role", "Bitmap", "Set resolver", "Set subregistry"].map((h) => (
                    <th key={h} scope="col" className="label px-4 py-2.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {catalogue.map((role) => (
                  <tr key={role.name}>
                    <th
                      scope="row"
                      className="px-4 py-3 text-left font-mono text-sm font-normal text-ink"
                    >
                      {role.name}
                      {role.ordinal === 0 ? (
                        <span className="ml-2 font-mono text-[0.6875rem] text-ink-muted">
                          sentinel
                        </span>
                      ) : null}
                    </th>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">
                      {role.bitmap === 0n ? "0" : `0x${role.bitmap.toString(16)}`}
                    </td>
                    <td className="px-4 py-3">
                      <Yes on={role.canSetResolver} />
                    </td>
                    <td className="px-4 py-3">
                      <Yes on={role.canSetSubregistry} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-ink-muted">
            No role grants <code className="font-mono">ROLE_CAN_TRANSFER_ADMIN</code>
            {catalogue.every((r) => !r.transferable) ? " — every membership is soulbound." : "."}{" "}
            A bitmap of <code className="font-mono">0</code> means the holder owns the name and
            cannot edit its records.
          </p>
        </Panel>

        {/* Permissions: who may act on the registrar */}
        <Panel as="section" className="overflow-hidden">
          <PanelHeader right={<SourceTag source="chain" />}>Registrar permissions</PanelHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] border-collapse text-left">
              <caption className="sr-only">
                Which accounts hold each registrar permission at ROOT_RESOURCE
              </caption>
              <thead>
                <tr className="border-b border-rule">
                  {["Account", "Onboard", "Promote", "Revoke"].map((h) => (
                    <th key={h} scope="col" className="label px-4 py-2.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {holders.map((holder, i) => (
                  <tr key={holder.account}>
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <span className="font-mono text-sm text-ink">{WATCHED[i].label}</span>
                      <a
                        href={explorer(holder.account)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 block font-mono text-[0.6875rem] text-ink-muted underline decoration-rule underline-offset-2 hover:text-ink"
                      >
                        {holder.account.slice(0, 10)}…{holder.account.slice(-4)}
                      </a>
                    </th>
                    <td className="px-4 py-3">
                      <Yes on={holder.permissions.onboard} />
                    </td>
                    <td className="px-4 py-3">
                      <Yes on={holder.permissions.promote} />
                    </td>
                    <td className="px-4 py-3">
                      <Yes on={holder.permissions.revoke} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-ink-muted">
            Permissions govern the console; registry roles govern the name. A volunteer holding
            only <code className="font-mono">onboard</code> can mint hackers and nothing above —
            the registrar refuses, because EAC cannot express that restriction on its own.
          </p>
        </Panel>
      </div>
    </>
  );
}
