import { bytesToBase64Url } from "../../src/auth/jwt";

/** Must match SUPABASE_JWT_SECRET in vitest.config.ts. */
export const TEST_JWT_SECRET = "test-jwt-secret";

const encoder = new TextEncoder();

/** Sign a Supabase-style HS256 JWT for tests. */
export async function signTestJwt(
  claims: Record<string, unknown>,
  secret = TEST_JWT_SECRET,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = bytesToBase64Url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const data = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

/** A valid user token for `userId`, expiring an hour from now. */
export async function userToken(userId: string, email?: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return signTestJwt({
    sub: userId,
    email: email ?? `${userId}@example.com`,
    role: "authenticated",
    iat: nowSec,
    exp: nowSec + 3600,
    aud: "authenticated",
  });
}

export async function authHeader(userId: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await userToken(userId)}` };
}
