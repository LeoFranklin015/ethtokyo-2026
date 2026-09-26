import { classify } from "./allowlist";

export type HandlerOpts = {
  chainIdHex: string;
  accountFetch: () => Promise<string[]>;
  rpcFetch: (body: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export function createHandler(opts: HandlerOpts) {
  return async function handle(req: { method: string; params?: unknown[] }) {
    switch (req.method) {
      case "eth_chainId":
        return opts.chainIdHex;
      case "net_version":
        return String(parseInt(opts.chainIdHex, 16));
      case "eth_accounts":
      case "eth_requestAccounts":
        return opts.accountFetch();
    }
    if (classify(req.method) === "read") {
      return opts.rpcFetch({ method: req.method, params: req.params });
    }
    throw { code: 4200, message: `read-only wallet: ${req.method} not permitted` };
  };
}
