"use client";

/**
 * Talking to the branch enforcer.
 *
 * Everything goes through `/api/admin/[...path]`, which holds the enforcer's admin token
 * server-side and is gated by `middleware.ts`. This module only shapes the request and, more
 * importantly, keeps the *kind* of failure intact.
 *
 * That last part is the whole reason this file is not three lines. The enforcer distinguishes
 * "that name is taken" (409) from "you are not signed in" (401) from "the enforcer did not
 * answer" (502), and collapsing them into one `Error` is how the console ended up telling an
 * operator the backend was down when the real answer was that their group already existed.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The enforcer's own `error` field, e.g. `name_taken`. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The console's own gate, not the enforcer refusing. */
  get isUnauthenticated() {
    return this.status === 401;
  }

  /** A named conflict: the thing exists, or something depends on it. */
  get isConflict() {
    return this.status === 409;
  }

  get isMissing() {
    return this.status === 404;
  }

  /** The enforcer could not be reached. Never render this as "there is nothing here". */
  get isUnreachable() {
    return this.status === 502 || this.status === 503 || this.status === 0;
  }
}

async function request<T>(
  method: string,
  path: string,
  options: { params?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`/api/admin/${path}`, window.location.origin);
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      cache: "no-store",
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (e) {
    throw new ApiError(0, null, e instanceof Error ? e.message : "could not reach the console");
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // An HTML error page, which means something upstream failed before the enforcer answered.
    parsed = null;
  }

  if (!res.ok) {
    const code =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : null;
    throw new ApiError(res.status, code, describe(res.status, code, path));
  }

  return parsed as T;
}

/** What an operator should read. The enforcer's codes are terse and a few are misleading. */
function describe(status: number, code: string | null, path: string): string {
  if (status === 401) return "NOT_SIGNED_IN";
  if (status === 502 || status === 503) return "The perimeter enforcer did not answer.";

  switch (code) {
    case "name_taken":
      return "A group with that name already exists.";
    case "username_taken":
      return "That username is already taken.";
    case "slug_taken":
      return "A resource with that slug already exists.";
    case "group_has_members":
      return "That group still has members. Move them first.";
    case "group_has_active_sessions":
      return "Somebody from that group is online. End their session first.";
    case "resource_has_active_limits — remove group limits first":
    case "resource_has_active_limits":
      return "Groups still have access to that resource. Revoke those first.";
    case "not_found":
      return "That no longer exists.";
    case "no_pending_key":
      return "There is no staged key to commit.";
    case "invalid_param":
      return "One of the filters was not valid.";
    default:
      return code ?? `${path} failed (${status})`;
  }
}

export const api = {
  get: <T,>(path: string, params?: Record<string, string | undefined>) =>
    request<T>("GET", path, { params }),
  post: <T,>(path: string, body?: unknown) => request<T>("POST", path, { body }),
  put: <T,>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  patch: <T,>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  delete: <T,>(path: string) => request<T>("DELETE", path),
};

/** Kept for the read hooks that predate `api`. */
export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  return api.get<T>(path, params);
}
