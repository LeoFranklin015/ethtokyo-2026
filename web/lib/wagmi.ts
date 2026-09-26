import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

/**
 * Wallet connection — wagmi v3, WalletConnect over a Reown project.
 *
 * An organization is a name somebody owns, so the create flow starts by asking whose name it is.
 * Every downstream `owner` — the org name, root of a branch registry, a membership — is the
 * address connected here. The server's key signs and pays; it never owns.
 */

export const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

/** Sepolia only: every contract in `lib/ens/config` is deployed there and nowhere else. */
export const chain = sepolia;

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [
    injected(),
    // Omitting the connector entirely is better than registering it with an empty projectId,
    // which fails at connect time with an error that points nowhere near the cause.
    ...(projectId
      ? [
          walletConnect({
            projectId,
            showQrModal: true,
            metadata: {
              name: "ENSCA",
              description: "An ENS subname is the credential for physical infrastructure",
              url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
              icons: [],
            },
          }),
        ]
      : []),
  ],
  // Cookie storage so a connection survives SSR and a refresh mid-flow — losing the wallet
  // halfway through buying a name is the one thing this flow cannot afford.
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  // Explicitly configured, and batched conservatively.
  //
  // `http()` with no URL falls back to viem's chain default, which for Sepolia is thirdweb —
  // and that caps keyless access at 100 calls per JSON-RPC batch and 1,000 blocks per
  // `eth_getLogs`. Reading a handful of branches is enough to cross the first, and the wallet
  // surfaces it as "Request exceeds defined limit", which points at nothing you can act on.
  //
  // A batch ceiling well under the lowest cap we have measured matters more than the endpoint:
  // it means no provider can be overrun, whichever one an operator points this at.
  transports: {
    [sepolia.id]: http(process.env.NEXT_PUBLIC_RPC_URL || undefined, {
      batch: { batchSize: 40, wait: 16 },
    }),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
