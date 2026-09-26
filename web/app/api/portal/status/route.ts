import { NextRequest, NextResponse } from "next/server";
import { admissionStatus } from "@/lib/portal/admit";
import { clientIp } from "../challenge/route";

export const dynamic = "force-dynamic";

/**
 * Is the device asking already on the network?
 *
 * The captive page opens far more often than anyone signs in — every OS probe reopens it — so it
 * asks this first and skips the whole badge-and-signature walk for a device that is already
 * admitted. `admitted: null` means the enforcer did not answer, which is not the same as "no"
 * and leaves the page to start from the beginning rather than claim anything.
 */
export async function GET(req: NextRequest) {
  const status = await admissionStatus(clientIp(req));
  if (!status) return NextResponse.json({ admitted: null });
  return NextResponse.json({
    admitted: status.admitted,
    ens_name: status.ensName ?? null,
    tier: status.tier ?? null,
  });
}
