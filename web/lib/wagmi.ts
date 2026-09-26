import { cookieStorage, createStorage, http } from "wagmi";
import { sepolia as wagmiSepolia } from "wagmi/chains";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createAppKit } from "@reown/appkit/react";
import { sepolia } from "@reown/appkit/networks";

/**
 * Wallet connection — wagmi v3 behind Reown AppKit.
 *
 * An organization is a name somebody owns, so the create flow starts by asking whose name it is.
 * Every downstream `owner` — the org name, root of a branch registry, a membership — is the
 * address connected here. Nothing is signed for anyone: the contracts check the connected wallet.
 *
 * AppKit rather than a hand-rolled button because the previous UI only ever offered
 * `connectors[0]`, the injected one. WalletConnect was configured and unreachable, so a phone
 * with no extension had no way in at all — on a product whose whole flow is signed from a wallet.
 */

export const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

/** Sepolia only: every contract in `lib/ens/config` is deployed there and nowhere else. */
export const chain = wagmiSepolia;

const metadata = {
  name: "Radius",
  description: "An ENS subname is the credential for physical infrastructure",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  icons: [],
};

const adapter = new WagmiAdapter({
  projectId,
  networks: [sepolia],
  // Cookie storage so a connection survives SSR and a refresh mid-flow — losing the wallet
  // halfway through buying a name is the one thing this flow cannot afford.
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  // Explicitly configured, and batched conservatively.
  //
  // `http()` with no URL falls back to viem's chain default, which for Sepolia is thirdweb —
  // and that caps keyless access at 100 calls per JSON-RPC batch. Reading a handful of branches
  // is enough to cross it, and the wallet surfaces it as "Request exceeds defined limit", which
  // points at nothing you can act on.
  //
  // A ceiling well under the lowest cap we have measured matters more than the endpoint: no
  // provider can be overrun, whichever one an operator points this at.
  transports: {
    [sepolia.id]: http(process.env.NEXT_PUBLIC_RPC_URL || undefined, {
      batch: { batchSize: 40, wait: 16 },
    }),
  },
});

export const wagmiConfig = adapter.wagmiConfig;

/**
 * Built at module scope so it happens exactly once.
 *
 * Skipped without a project id: AppKit with an empty one fails at connect time with an error
 * that points nowhere near the cause, and the app still works through an injected wallet.
 */
export const appKit = projectId
  ? createAppKit({
      adapters: [adapter],
      networks: [sepolia],
      defaultNetwork: sepolia,
      projectId,
      metadata,
      features: { analytics: false, email: false, socials: false },
    })
  : null;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
