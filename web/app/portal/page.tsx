import { PortalFlow } from "@/components/PortalFlow";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata = { title: "Portal — ENSCA" };

export default function PortalPage() {
  return (
    <>
      <SiteHeader current="/portal" />
      <main
        id="main"
        className="paper-grid flex flex-1 flex-col items-center justify-center px-5 py-12"
      >
        <PortalFlow />
      </main>
    </>
  );
}
