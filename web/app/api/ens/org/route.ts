import { NextResponse } from "next/server";
import { ENS } from "@/lib/ens/config";

export const dynamic = "force-dynamic";

/**
 * What organization this console is pointed at.
 *
 * There is no signer to report any more. This route used to answer "can the server sign, and as
 * whom", and to accept a POST that bought an organization name with the server's own key and
 * money — which is why claiming a name sat behind a shared console token and told newcomers
 * "console authentication required" before they had done anything.
 *
 * An organization is a name somebody owns. They buy it from their own wallet
 * (`lib/ens/useOrgRegistration.ts`), so there is nothing of ours to protect and nobody to
 * authorise.
 */
export async function GET() {
  return NextResponse.json({
    organization: ENS.organization,
    chainId: 11155111,
    registrar: ENS.ethRegistrar,
    paymentToken: ENS.paymentToken,
  });
}
