import { redirect } from "next/navigation";

/**
 * The old memberships tab.
 *
 * It listed the chain, and `/console/users` listed the enforcer, so neither could show where the
 * two disagree — which is the one thing worth knowing during an event. `/console/people` joins
 * them and carries the onboarding form that used to live here. Kept as a redirect because the
 * creation wizard and old bookmarks still point at this path.
 */
export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  redirect(org ? `/console/people?org=${encodeURIComponent(org)}` : "/console/people");
}
