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
  // The browser reads through the chain default; the server keeps its own client in lib/ens.
  transports: { [sepolia.id]: http() },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
