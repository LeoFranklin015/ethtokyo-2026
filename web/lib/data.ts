/**
 * Shapes the enforcer returns.
 *
 * Everything else that used to live here — `RoleName`, `GroupName`, `Branch`, `Membership`,
 * `Role` — was a closed vocabulary invented before the real ones existed on chain. Roles are
 * arbitrary strings an organization defines; branches come from ENS.
 */

/**
 * One point of the enforcer's 10-minute throughput buckets.
 *
 * `active_ips` is the distinct client addresses that sent traffic in the bucket. It used to be
 * called `admitted`, which it never was: somebody admitted and idle sends nothing and so
 * appears in no bucket at all.
 */
export type Sample = { t: string; mbps: number; active_ips: number };
