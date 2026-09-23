import { UnauthenticatedError } from "../errors";

/**
 * Minimal, dependency-free Supabase JWT verification.
 *
 * Splatt authenticates users with Supabase Auth, which issues HS256-signed
 * access tokens signed with the project's JWT secret. This module verifies those
 * tokens server-side (signature + expiry) using WebCrypto, so the agent reuses
 * Splatt's existing authentication rather than introducing a parallel one.
 *
 * [UNVERIFIED] Projects configured with asymmetric (ES256/RS256) signing keys
 * would need JWKS verification instead; that path is not implemented here.
 */

export interface SupabaseClaims {
  /** Supabase user id (auth.users.id). Used as the isolation principal. */
  sub: string;
  email?: string;
  role?: string;
  exp?: number;
  nbf?: number;
  aud?: string | string[];
  [key: string]: unknown;
}

const encoder = new TextEncoder();

export async function verifySupabaseJwt(
  token: string,
  secret: string,
  now: () => number = () => Date.now(),
): Promise<SupabaseClaims> {
  if (!secret) {
    throw new UnauthenticatedError("Auth secret not configured");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new UnauthenticatedError("Malformed token");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(decodeBase64Url(headerB64));
  } catch {
    throw new UnauthenticatedError("Malformed token header");
  }
  if (header.alg !== "HS256") {
    throw new UnauthenticatedError(`Unsupported token algorithm: ${header.alg}`);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signatureB64),
    encoder.encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) {
    throw new UnauthenticatedError("Invalid token signature");
  }

  let claims: SupabaseClaims;
  try {
    claims = JSON.parse(decodeBase64Url(payloadB64));
  } catch {
    throw new UnauthenticatedError("Malformed token payload");
  }

  const nowSeconds = Math.floor(now() / 1000);
  // 60s leeway for clock skew.
  if (typeof claims.exp === "number" && nowSeconds > claims.exp + 60) {
    throw new UnauthenticatedError("Token expired");
  }
  if (typeof claims.nbf === "number" && nowSeconds + 60 < claims.nbf) {
    throw new UnauthenticatedError("Token not yet valid");
  }
  if (!claims.sub || typeof claims.sub !== "string") {
    throw new UnauthenticatedError("Token missing subject");
  }
  return claims;
}

// --- base64url helpers (no Buffer dependency) ---

export function decodeBase64Url(input: string): string {
  const bytes = base64UrlToBytes(input);
  return new TextDecoder().decode(bytes);
}

export function base64UrlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
