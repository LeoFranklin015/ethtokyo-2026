import { PortalFlow } from "@/components/PortalFlow";

export const metadata = { title: "Portal — ENSCA" };

/**
 * The captive page, which is not the rest of the site.
 *
 * It is opened by the operating system in a stripped webview on a phone, by somebody who is not
 * on the network yet — so the site header is gone. Its links go nowhere reachable from here, and
 * the wallet it offers is the one thing this page has to manage itself, next to the badge it has
 * to match against.
 */
export default function PortalPage() {
  return (
    <main
      id="main"
      className="paper-grid flex flex-1 flex-col items-center justify-center px-4 py-8 sm:py-12"
    >
      <p className="mb-6 font-mono text-sm font-medium tracking-[0.18em] text-ink">ENSCA</p>
      <PortalFlow />
    </main>
  );
}
