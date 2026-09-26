"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { OrgSetup } from "@/components/console/OrgSetup";
import { ENS } from "@/lib/ens/config";

export default function SetupPage() {
  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Setup"
        meta={`Currently configured: ${ENS.organization}`}
      />
      <div className="px-5 py-6 lg:px-8">
        <div className="max-w-[560px]">
          <OrgSetup />
          <p className="mt-4 text-xs leading-relaxed text-ink-muted">
            The organization name is the trust root. Branches are registered beneath it, and every
            membership resolves through it — so this is the one name that has to be bought.
          </p>
        </div>
      </div>
    </>
  );
}
