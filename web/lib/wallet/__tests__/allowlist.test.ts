import { describe, it, expect } from "vitest";
import { READ_METHODS, SIGNING_METHODS, classify } from "../allowlist";

describe("wallet allowlist", () => {
  it("classifies a read method as read", () => {
    expect(classify("eth_call")).toBe("read");
  });
  it("rejects every enumerated signing method", () => {
    for (const m of SIGNING_METHODS) {
      expect(classify(m)).toBe("reject");
    }
  });
  it("rejects an unknown/future method by default", () => {
    expect(classify("eth_signFutureThing")).toBe("reject");
  });
  it("no signing method leaks into the read set", () => {
    for (const m of SIGNING_METHODS) {
      expect(READ_METHODS.has(m)).toBe(false);
    }
  });
});
