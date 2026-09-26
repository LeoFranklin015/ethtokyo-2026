"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { EnsBranches } from "@/components/console/EnsBranches";
import { NoOrgSelected } from "@/components/console/OrgPicker";
import { useOrg } from "@/lib/hooks/useOrg";

export default function BranchesPage() {
  const org = useOrg();
  if (!org) return <NoOrgSelected />;

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Perimeters"
        meta={`Names under ${`${org}.eth`} that carry a registry of their own`}
      />
      <div className="px-5 py-6 lg:px-8">
        <EnsBranches org={org} />
      </div>
    </>
  );
}
