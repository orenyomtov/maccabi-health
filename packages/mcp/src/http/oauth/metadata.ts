import { buildOAuthProtectedResourceMetadata, type AuthMetadataOptions, type OAuthMetadata } from "@modelcontextprotocol/server";

export const OAUTH_SCOPE = "maccabi";
export const AUTHORIZE_PATH = "/authorize";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";
export const REVOKE_PATH = "/revoke";
export const WELL_KNOWN_PREFIX = "/.well-known/";

/**
 * The SDK derives the RFC 9728 document but has no RFC 8414 builder, so the Authorization Server
 * document is written out here and passed through verbatim. Every URL in it comes from the bound
 * address, which is only known once the socket is listening — `port: 0` in tests would otherwise
 * produce an issuer that no client can reach.
 */
export function buildAuthMetadata(origin: URL, resourceServerUrl: URL): AuthMetadataOptions {
  const issuer = origin.origin;
  const oauthMetadata: OAuthMetadata = {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    registration_endpoint: `${issuer}${REGISTER_PATH}`,
    revocation_endpoint: `${issuer}${REVOKE_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // A conforming MCP client verifies this is present and refuses to proceed without it.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [OAUTH_SCOPE],
  };
  const options: AuthMetadataOptions = {
    oauthMetadata, resourceServerUrl, scopesSupported: [OAUTH_SCOPE], resourceName: "Maccabi personal health records",
  };
  // Fails fast on a bad issuer here rather than on the first client request. The loopback carve-out
  // means plain http is accepted without dangerouslyAllowInsecureIssuerUrl; needing that flag would
  // mean this server is no longer bound to loopback and none of the rest of this design still holds.
  buildOAuthProtectedResourceMetadata(options);
  return options;
}
