export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`/api/admin/${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  // A 401 is the console's own gate, not the enforcer refusing. Saying "the enforcer did not
  // answer" for it sends the operator to debug the wrong machine.
  if (res.status === 401) {
    throw new Error("NOT_SIGNED_IN");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
