"use client";

import useSWR from "swr";
import { api } from "@/lib/api";

/**
 * Everything the branch enforcer knows.
 *
 * One module because these all key off the same admin API and mutate each other: granting a
 * group access to a resource changes what both of them look like, so the revalidation has to
 * live next to the fetch rather than be remembered at every call site.
 */

export type Resource = {
  id: string;
  slug: string;
  display_name: string;
  upstream_url: string;
  key_placement: string;
  key_header_name: string | null;
  query_param_name: string | null;
  strip_path_prefix: boolean;
  enabled: boolean;
  has_pending_key: boolean;
  created_at: number;
  notes: string | null;
  /** Only on the detail read — the list returns no key field at all. */
  api_key_masked?: string;
  api_key_b64_user?: string;
  group_access?: {
    group_id: string;
    group_name: string;
    per_device_per_day: number | null;
    group_per_day: number | null;
  }[];
};

export type Group = {
  id: string;
  name: string;
  network_tier: string;
  notes: string | null;
  member_count: number;
  active_session_count: number;
};

export type GroupDetail = Group & {
  members: { id: string; username: string; disabled: number }[];
  limits: Record<string, { per_device_per_day: number | null; group_per_day: number | null }>;
  usage_today: Record<string, { used: number; limit: number | null }>;
};

export type User = {
  id: string;
  username: string;
  default_group_id: string | null;
  ens_name: string | null;
  wallet_address: string | null;
  created_at: number;
  disabled: number | boolean;
};

export type UserDetail = Omit<User, "default_group_id"> & {
  group: { id: string; name: string; network_tier: string } | null;
  notes: string | null;
  active_session: { id: string; ip: string; logged_in_at: number } | null;
  usage_today: Record<string, { used: number; limit: number | null }>;
};

export type Limits = {
  per_device_per_day: number | null;
  group_per_day: number | null;
  per_ens_per_day: number | null;
};

export function useResources() {
  const { data, error, isLoading, mutate } = useSWR<{ resources: Resource[] }>(
    "resources",
    () => api.get("resources"),
    { refreshInterval: 30_000 },
  );
  return { resources: data?.resources, error, isLoading, reload: mutate };
}

export function useResource(id: string | null) {
  const { data, error, isLoading, mutate } = useSWR<Resource>(
    id ? `resource:${id}` : null,
    () => api.get<Resource>(`resources/${id}`),
  );
  return { resource: data, error, isLoading, reload: mutate };
}

export function useEnforcerGroups() {
  const { data, error, isLoading, mutate } = useSWR<{ groups: Group[] }>(
    "groups",
    () => api.get("groups"),
    { refreshInterval: 30_000 },
  );
  return { groups: data?.groups, error, isLoading, reload: mutate };
}

export function useGroupDetail(id: string | null) {
  const { data, error, isLoading, mutate } = useSWR<GroupDetail>(
    id ? `group:${id}` : null,
    () => api.get<GroupDetail>(`groups/${id}`),
  );
  return { group: data, error, isLoading, reload: mutate };
}

export function useEnforcerUsers(params?: { group_id?: string; disabled?: string; offset?: number }) {
  const key = `users:${params?.group_id ?? ""}:${params?.disabled ?? ""}:${params?.offset ?? 0}`;
  const { data, error, isLoading, mutate } = useSWR<{ users: User[]; total: number }>(
    key,
    () =>
      api.get("users", {
        limit: "50",
        offset: String(params?.offset ?? 0),
        group_id: params?.group_id,
        disabled: params?.disabled,
      }),
    { refreshInterval: 30_000 },
  );
  return { users: data?.users, total: data?.total, error, isLoading, reload: mutate };
}

export function useUserDetail(id: string | null) {
  const { data, error, isLoading, mutate } = useSWR<UserDetail>(
    id ? `user:${id}` : null,
    () => api.get<UserDetail>(`users/${id}`),
  );
  return { user: data, error, isLoading, reload: mutate };
}

/**
 * Grant or update a group's access to a resource.
 *
 * All three caps are sent every time, deliberately. `PUT` is a full replace on the enforcer, so
 * omitting `per_ens_per_day` silently sets it to unlimited — and since `GET /admin/groups/:id`
 * does not return that column, the loss would be invisible through the API.
 */
export function grantAccess(groupId: string, resourceId: string, limits: Limits) {
  return api.put(`groups/${groupId}/limits/${resourceId}`, {
    per_device_per_day: limits.per_device_per_day,
    group_per_day: limits.group_per_day,
    per_ens_per_day: limits.per_ens_per_day,
  });
}

/** Removing the row is the only way to take access away — there is no disabled flag on it. */
export function revokeAccess(groupId: string, resourceId: string) {
  return api.delete(`groups/${groupId}/limits/${resourceId}`);
}

/**
 * Groups × resources, as one object.
 *
 * The grants live in a join table with no endpoint of its own, so the matrix has to be assembled:
 * every resource's detail read carries its `group_access` list, which is the cheaper half of the
 * pair (there are usually fewer resources than groups). `per_ens_per_day` is deliberately absent —
 * the enforcer accepts it on write and returns it nowhere, so the matrix cannot show it.
 */
export function useAccessMatrix() {
  const groups = useEnforcerGroups();
  const resources = useResources();

  const ids = (resources.resources ?? []).map((r) => r.id).sort();
  const details = useSWR<Resource[]>(
    ids.length ? `access:${ids.join(",")}` : null,
    () => Promise.all(ids.map((id) => api.get<Resource>(`resources/${id}`))),
    { refreshInterval: 30_000 },
  );

  const grants = new Map<string, { per_device_per_day: number | null; group_per_day: number | null }>();
  for (const detail of details.data ?? []) {
    for (const access of detail.group_access ?? []) {
      grants.set(`${access.group_id}:${detail.id}`, {
        per_device_per_day: access.per_device_per_day,
        group_per_day: access.group_per_day,
      });
    }
  }

  return {
    groups: groups.groups,
    resources: resources.resources,
    grants,
    error: groups.error ?? resources.error ?? details.error,
    isLoading: groups.isLoading || resources.isLoading || (ids.length > 0 && !details.data),
    reload: async () => {
      await Promise.all([groups.reload(), resources.reload(), details.mutate()]);
    },
  };
}
