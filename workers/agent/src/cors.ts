/**
 * CORS with an explicit origin allowlist (comma-separated `ALLOWED_ORIGINS`).
 * Unlisted origins get no CORS headers, so browsers refuse the response.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter((o) => o.length > 0);
}

export function corsHeadersFor(request: Request, allowedOrigins: string[]): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins.includes(origin.replace(/\/$/, ""))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
