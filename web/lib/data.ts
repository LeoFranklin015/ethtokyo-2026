/**
 * Shapes the enforcer returns.
 *
 * Everything else that used to live here — `RoleName`, `GroupName`, `Branch`, `Membership`,
 * `Role` — was a closed vocabulary invented before the real ones existed on chain. Roles are
 * arbitrary strings an organization defines; branches come from ENS.
 */

/** One point of the enforcer's 10-minute throughput buckets. */
export type Sample = { t: string; mbps: number; admitted: number };
