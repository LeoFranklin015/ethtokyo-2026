"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { EnsBranches } from "@/components/console/EnsBranches";
import { ENS } from "@/lib/ens/config";

export default function BranchesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Branches"
        meta={`Names under ${ENS.organization} that carry a registry of their own`}
      />
      <div className="px-5 py-6 lg:px-8">
        <EnsBranches />
      </div>
    </>
  );
}
