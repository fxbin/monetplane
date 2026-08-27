/**
 * Admin API client for dashboard data fetching.
 *
 * Calls admin API routes (src/app/api/admin/*) which are auth-gated
 * by Auth.js session cookies. This client never touches the Server SDK
 * `appSecret` — that stays server-side only.
 */

type RequestOptions = {
  method?: string;
  body?: unknown;
};

async function adminFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers:
      options.body !== undefined
        ? { "content-type": "application/json" }
        : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });

  if (!response.ok) {
    if (response.status === 401) {
      window.location.href = "/login";
      throw new Error("Session expired");
    }
    throw new Error(`Admin API error: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export { adminFetch };
