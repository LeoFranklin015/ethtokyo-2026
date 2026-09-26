/** Minimal ABIs — only what the console reads from the V2 contracts. */

export const registryAbi = [
  { type: "function", name: "getStatus", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "getOwner", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getExpiry", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "getResource", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getSubregistry", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "roles", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "roleCount", stateMutability: "view", inputs: [{ name: "resource", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export const registrarV2Abi = [
  { type: "function", name: "roleOf", stateMutability: "view", inputs: [{ name: "resource", type: "uint256" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "membershipOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveRole", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "role", type: "bytes32" }, { name: "fromOrg", type: "bool" }] },
  { type: "function", name: "roleSpec", stateMutability: "view", inputs: [{ name: "roleId", type: "bytes32" }], outputs: [{ name: "registryBitmap", type: "uint256" }, { name: "canOnboard", type: "bool" }, { name: "openToOnboarders", type: "bool" }, { name: "active", type: "bool" }] },
  { type: "function", name: "entitlementsOf", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }], outputs: [{ type: "tuple[]", components: [{ name: "key", type: "string" }, { name: "value", type: "string" }] }] },
  { type: "function", name: "roleResource", stateMutability: "pure", inputs: [{ name: "roleId", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "membershipNode", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "hasRoles", stateMutability: "view", inputs: [{ name: "resource", type: "uint256" }, { name: "roleBitmap", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "ROLE_MINT", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "RoleDefined",
    inputs: [
      { name: "roleId", type: "bytes32", indexed: true },
      { name: "name", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Onboarded",
    inputs: [
      { name: "resource", type: "uint256", indexed: true },
      { name: "label", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
      { name: "roleId", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const orgRegistrarAbi = [
  { type: "function", name: "isMember", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "memberOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "labelOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "string" }] },
  { type: "function", name: "orgRole", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bytes32" }] },
] as const;

export const resolverAbi = [
  { type: "function", name: "text", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }], outputs: [{ type: "string" }] },
] as const;

/** ENSv2 ETHRegistrar — commit/reveal registration of a `.eth` name. */
export const ethRegistrarAbi = [
  { type: "function", name: "isAvailable", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "getRegisterPrice", stateMutability: "view", inputs: [{ name: "label", type: "string" }, { name: "duration", type: "uint64" }, { name: "paymentToken", type: "address" }], outputs: [{ name: "base", type: "uint256" }, { name: "premium", type: "uint256" }] },
  { type: "function", name: "makeCommitment", stateMutability: "pure", inputs: [{ name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "secret", type: "bytes32" }, { name: "subregistry", type: "address" }, { name: "resolver", type: "address" }, { name: "duration", type: "uint64" }, { name: "referrer", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "commitmentAt", stateMutability: "view", inputs: [{ name: "commitment", type: "bytes32" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "MIN_COMMITMENT_AGE", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "commit", stateMutability: "nonpayable", inputs: [{ name: "commitment", type: "bytes32" }], outputs: [] },
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "secret", type: "bytes32" }, { name: "subregistry", type: "address" }, { name: "resolver", type: "address" }, { name: "duration", type: "uint64" }, { name: "paymentToken", type: "address" }, { name: "referrer", type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** Registrar writes the console performs on behalf of the organization. */
export const registrarWriteAbi = [
  { type: "function", name: "defineRole", stateMutability: "nonpayable", inputs: [
    { name: "name", type: "string" },
    { name: "registryBitmap", type: "uint256" },
    { name: "canOnboard", type: "bool" },
    { name: "openToOnboarders", type: "bool" },
    { name: "editableKeys", type: "string[]" },
    { name: "grants", type: "tuple[]", components: [{ name: "key", type: "string" }, { name: "value", type: "string" }] },
  ], outputs: [] },
  { type: "function", name: "onboard", stateMutability: "nonpayable", inputs: [
    { name: "label", type: "string" },
    { name: "owner", type: "address" },
    { name: "role", type: "bytes32" },
    { name: "memberLabel", type: "string" },
  ], outputs: [{ type: "uint256" }] },
  { type: "function", name: "roleId", stateMutability: "pure", inputs: [{ name: "name", type: "string" }], outputs: [{ type: "bytes32" }] },
] as const;
