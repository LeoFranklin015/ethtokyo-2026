/** Minimal ABIs — only the functions and events the console reads. */

export const registryAbi = [
  { type: "function", name: "getStatus", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "getOwner", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getExpiry", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "getResource", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getSubregistry", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getResolver", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getParent", stateMutability: "view", inputs: [], outputs: [{ type: "address" }, { type: "string" }] },
  { type: "function", name: "roles", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "hasRootRoles", stateMutability: "view", inputs: [{ name: "roleBitmap", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "roleCount", stateMutability: "view", inputs: [{ name: "resource", type: "uint256" }], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "LabelRegistered",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "labelHash", type: "bytes32", indexed: true },
      { name: "label", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: false },
      { name: "expiry", type: "uint64", indexed: false },
      { name: "sender", type: "address", indexed: true },
    ],
  },
] as const;

export const registrarAbi = [
  { type: "function", name: "roleOf", stateMutability: "view", inputs: [{ name: "resource", type: "uint256" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "membershipOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "memberOf", stateMutability: "view", inputs: [{ name: "resource", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "membership", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "exists", type: "bool" }, { name: "resource", type: "uint256" }, { name: "role", type: "uint8" }] },
  { type: "function", name: "registryBitmapFor", stateMutability: "pure", inputs: [{ name: "role", type: "uint8" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "hasRootRoles", stateMutability: "view", inputs: [{ name: "roleBitmap", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "BRANCH_EXPIRY", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "RESOLVER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "event",
    name: "Onboarded",
    inputs: [
      { name: "resource", type: "uint256", indexed: true },
      { name: "label", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
      { name: "role", type: "uint8", indexed: false },
    ],
  },
  { type: "event", name: "Revoked", inputs: [{ name: "resource", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true }] },
  { type: "event", name: "Promoted", inputs: [{ name: "resource", type: "uint256", indexed: true }, { name: "oldRole", type: "uint8", indexed: false }, { name: "newRole", type: "uint8", indexed: false }] },
] as const;

export const resolverAbi = [
  { type: "function", name: "text", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }], outputs: [{ type: "string" }] },
] as const;
