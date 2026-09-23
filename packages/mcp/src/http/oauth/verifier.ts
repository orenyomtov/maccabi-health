import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import type { OAuthStore } from "./store";

/** Carried in `AuthInfo.extra`, because `AuthInfo` has no subject field of its own. */
export function subjectFrom(authInfo: AuthInfo | undefined): string {
  const subject = authInfo?.extra?.["subject"];
  if (typeof subject !== "string" || !/^[0-9a-f]{32}$/.test(subject)) throw new Error("This request reached the MCP handler without an authenticated subject.");
  return subject;
}

/**
 * The Resource Server half. Audience binding is enforced here on purpose: `verifyBearerToken` checks
 * the header shape, the verifier, the scopes and the expiry, and never compares `AuthInfo.resource`
 * to anything, but MCP requires a server to refuse a token that was not issued for it.
 */
export function createTokenVerifier(store: OAuthStore, resource: URL): OAuthTokenVerifier {
  const canonical = resource.href;
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const stored = store.lookupAccess(token);
      if (!stored) throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is unknown, revoked or expired.");
      if (stored.resource !== canonical) throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token was issued for a different resource.");
      return {
        token, clientId: stored.clientId, scopes: stored.scope === "" ? [] : stored.scope.split(" "),
        // Seconds, not milliseconds: bearer verification compares this against Date.now()/1000 and
        // rejects anything unset, so a millisecond value would silently never expire.
        expiresAt: Math.floor(stored.expiresAt / 1000),
        resource: new URL(canonical),
        extra: { subject: stored.subject },
      };
    },
  };
}
