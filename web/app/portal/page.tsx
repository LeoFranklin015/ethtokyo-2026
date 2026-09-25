import { PortalFlow } from "@/components/PortalFlow";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata = { title: "Portal — ENSCA" };

export default function PortalPage() {
  return (
    <>
      <SiteHeader current="/portal" />
      <main id="main" className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col items-center px-5 py-12">
        <p className="label mb-8 text-center">
          Captive portal · tokyo2026.ethglobal.eth
        </p>
        <PortalFlow />
      </main>
    </>
  );
}
