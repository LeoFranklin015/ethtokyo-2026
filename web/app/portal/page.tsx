import { PortalFlow, type Grant } from "@/components/PortalFlow";
import { SiteHeader } from "@/components/SiteHeader";
import { getBranch, getMemberships } from "@/lib/ens/branch";

export const metadata = { title: "Portal — ENSCA" };
export const revalidate = 30;

export default async function PortalPage() {
  const [branch, memberships] = await Promise.all([getBranch(), getMemberships()]);
  const member = memberships[0];

  // What the enforcer would resolve at admission, read from the same registry and resolver.
  const grant: Grant = member
    ? [
        { term: "Membership", detail: member.name },
        { term: "Role", detail: member.role },
        { term: "Group", detail: member.entitlements["wifi.group"] ?? "—" },
        {
          term: "Rate / ceiling",
          detail: `${member.entitlements["wifi.rate"] ?? "—"} / ${
            member.entitlements["wifi.ceil"] ?? "—"
          }`,
        },
      ]
    : [{ term: "Membership", detail: "none onboarded at this branch yet" }];

  return (
    <>
      <SiteHeader current="/portal" />
      <main
        id="main"
        className="paper-grid flex flex-1 flex-col items-center justify-center px-5 py-12"
      >
        <PortalFlow ssid={`ensca-${branch.branch.split(".")[0]}`} grant={grant} />
      </main>
    </>
  );
}
