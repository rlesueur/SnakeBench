/**
 * Minimal Google OAuth 2.0 (Authorization Code) client, hand-rolled with fetch.
 * No third-party OAuth library. Requires a Google Cloud OAuth client:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * and an authorised redirect URI of OAUTH_REDIRECT_BASE + /auth/google/callback.
 */
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export interface GoogleProfile {
  sub: string;
  email: string | null;
  name: string;
}

/** A value is a placeholder if it is empty or one of the obvious dev stand-ins
 * shipped in .env / .env.example. Treating these as "not configured" means the
 * server reports Google sign-in as unavailable (a clean 503) instead of sending
 * the user to Google with a bad client, which fails with a confusing
 * "OAuth client was not found / 401: invalid_client" page. */
function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  return v === "" || v.startsWith("dummy") || v.startsWith("your-") || v.startsWith("change");
}

export function isConfigured(): boolean {
  return (
    !isPlaceholder(process.env.GOOGLE_CLIENT_ID) &&
    !isPlaceholder(process.env.GOOGLE_CLIENT_SECRET) &&
    Boolean(process.env.OAUTH_REDIRECT_BASE)
  );
}

export function redirectUri(): string {
  return `${process.env.OAUTH_REDIRECT_BASE}/auth/google/callback`;
}

export function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Google token exchange returned no access_token.");
  return json.access_token;
}

export async function fetchProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Google userinfo failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { sub: string; email?: string; name?: string; email_verified?: boolean };
  // Only treat the email as usable when Google asserts it is verified;
  // unverified emails could be attacker-controlled and must not be trusted.
  const verifiedEmail = json.email && json.email_verified !== false ? json.email : null;
  return {
    sub: json.sub,
    email: verifiedEmail,
    name: json.name || (verifiedEmail ? verifiedEmail.split("@")[0]! : "player"),
  };
}
