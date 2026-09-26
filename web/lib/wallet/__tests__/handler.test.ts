import { describe, it, expect, vi } from "vitest";
import { createHandler } from "../handler";
import { SIGNING_METHODS } from "../allowlist";

const opts = () => ({
  chainIdHex: "0xaa36a7",
  accountFetch: vi.fn(async () => ["0xabc0000000000000000000000000000000000001"]),
  rpcFetch: vi.fn(async () => "0x64"),
});

describe("provider handler", () => {
  it("answers eth_chainId locally without touching rpc", async () => {
    const o = opts();
    const h = createHandler(o);
    expect(await h({ method: "eth_chainId" })).toBe("0xaa36a7");
    expect(o.rpcFetch).not.toHaveBeenCalled();
  });

  it("answers net_version as the decimal chain id", async () => {
    const h = createHandler(opts());
    expect(await h({ method: "net_version" })).toBe("11155111");
  });

  it("returns the fetched account for eth_accounts", async () => {
    const h = createHandler(opts());
    expect(await h({ method: "eth_accounts" })).toEqual([
      "0xabc0000000000000000000000000000000000001",
    ]);
  });

  it("forwards a read method to rpcFetch", async () => {
    const o = opts();
    const h = createHandler(o);
    await h({ method: "eth_getBalance", params: ["0xabc", "latest"] });
    expect(o.rpcFetch).toHaveBeenCalledWith({
      method: "eth_getBalance",
      params: ["0xabc", "latest"],
    });
  });

  it("throws 4200 for every enumerated signing method", async () => {
    const h = createHandler(opts());
    for (const m of SIGNING_METHODS) {
      await expect(h({ method: m })).rejects.toMatchObject({ code: 4200 });
    }
  });

  it("throws 4200 for an unknown method", async () => {
    const h = createHandler(opts());
    await expect(h({ method: "eth_signFutureThing" })).rejects.toMatchObject({
      code: 4200,
    });
  });
});
