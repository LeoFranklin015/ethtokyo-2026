// The read-only provider must expose itself on window.ethereum too, not only
// via EIP-6963. RainbowKit (the connect kit app.ens.domains uses) renders a
// "Browser Wallet" / "Injected" entry keyed off window.ethereum presence and
// filters unknown-rdns EIP-6963 providers out of its curated modal — so a
// pure EIP-6963 announce never appears there. The assignment must be guarded:
// it may fill an EMPTY window.ethereum but must NEVER clobber a real injected
// wallet already present, or we'd shadow the user's actual wallet.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const SRC = fileURLToPath(
  new URL("../../../public/wallet/provider.js", import.meta.url)
);

function makeWindow(overrides: Record<string, unknown> = {}) {
  const win: any = {
    addEventListener() {},
    dispatchEvent() {},
    ...overrides,
  };
  return win;
}

function runProvider(win: any) {
  const source = readFileSync(SRC, "utf8");
  const sandbox: any = {
    window: win,
    document: { readyState: "complete", addEventListener() {} },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    setTimeout: () => 0,
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: any) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  };
  // provider.js reads/writes window.* ; sandbox.window is the only window.
  runInNewContext(source, sandbox);
  return sandbox;
}

describe("provider window.ethereum injection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sets window.ethereum to the read-only provider when none exists", () => {
    const win = makeWindow();
    runProvider(win);
    expect(win.ethereum).toBeDefined();
    expect(win.ethereum.isVLANReadOnly).toBe(true);
    expect(typeof win.ethereum.request).toBe("function");
  });

  it("does NOT clobber a pre-existing injected wallet", () => {
    const real = { isMetaMask: true, request() {} };
    const win = makeWindow({ ethereum: real });
    runProvider(win);
    expect(win.ethereum).toBe(real);
    expect(win.ethereum.isVLANReadOnly).toBeUndefined();
  });
});
