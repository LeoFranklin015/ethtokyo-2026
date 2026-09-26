import methods from "@/public/wallet/read-methods.json";

export const READ_METHODS = new Set<string>(methods.read);
export const SIGNING_METHODS = new Set<string>(methods.signing);

export function classify(method: string): "read" | "reject" {
  return READ_METHODS.has(method) ? "read" : "reject";
}
