import type { IncomingMessage, ServerResponse } from "node:http";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { MaccabiError } from "@maccabi/core";
import { LoginError, startLogin, verifyLogin, type LoginDependencies } from "@maccabi/cli/login";
import { SessionStoreError } from "@maccabi/cli/store";
import { AUTHORIZE_PATH, OAUTH_SCOPE, REGISTER_PATH, REVOKE_PATH, TOKEN_PATH } from "./metadata";
import { errorPage, idPage, otpPage, PAGE_HEADERS, phonePage } from "./pages";
import { isRegistrableRedirect, matchesRegistered } from "./redirect";
import type { OAuthStore } from "./store";
import {
  AuthorizeSessions, MemoryPendingLoginStore, SubjectRoutedStore, clearedCookie, sessionCookie,
  type AuthorizeParams, type AuthorizeSession,
} from "./login-session";

const BODY_LIMIT = 16 * 1024;
/** RFC 7636: 43 to 128 characters from the unreserved set. Rejecting a malformed one early keeps a truncated challenge from looking like a verifier mismatch later. */
const CODE_CHALLENGE = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface OAuthRouterDependencies {
  store: OAuthStore;
  sessions: AuthorizeSessions;
  sessionsDir: string;
  /** Known only once the socket is listening, because `port: 0` picks the port. */
  origin: () => URL;
  resource: () => URL;
  createAuth: LoginDependencies["createAuth"];
  connect: LoginDependencies["connect"];
}
export type OAuthRouter = (request: IncomingMessage, response: ServerResponse, url: URL) => boolean;

export function writeWebResponse(response: ServerResponse, web: Response): void {
  const headers: Record<string, string> = {};
  web.headers.forEach((value, key) => { headers[key] = value; });
  response.writeHead(web.status, headers);
  void web.text().then(body => response.end(body), () => response.end());
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}
function sendHtml(response: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...PAGE_HEADERS, ...headers });
  response.end(html);
}
function statusFor(error: OAuthError): number {
  if (error.code === OAuthErrorCode.InvalidClient) return 401;
  if (error.code === OAuthErrorCode.TooManyRequests) return 429;
  if (error.code === OAuthErrorCode.ServerError) return 500;
  return 400;
}
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
function sendOAuthError(response: ServerResponse, path: string, error: unknown): void {
  const oauth = error instanceof OAuthError ? error : new OAuthError(OAuthErrorCode.ServerError, "The authorization server could not complete this request.");
  // /token and /register catch their own errors, so this is the only place that sees every 500 this
  // server sends. Without a line here the member's client reports an opaque failure and the terminal
  // running the server says nothing at all.
  if (oauth.code === OAuthErrorCode.ServerError) process.stderr.write(`Maccabi OAuth ${path} failed: ${reasonOf(error)}\n`);
  sendJson(response, statusFor(oauth), oauth.toResponseObject());
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > BODY_LIMIT) return null; // A registration or a form post is a few hundred bytes; anything larger is not one.
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The whole self-authored message set. Upstream text never reaches a page or a JSON body. */
function loginMessage(error: unknown): string {
  if (error instanceof LoginError) return error.message;
  if (error instanceof SessionStoreError) return "Protected storage could not be read or written. Check the permissions of the maccabi config directory, then try again.";
  if (error instanceof MaccabiError) return "The sign-in step did not complete. Start again; no code was resent and nothing was retried.";
  return "The sign-in step could not be completed.";
}

export function createOAuthRouter(deps: OAuthRouterDependencies): OAuthRouter {
  const scopeOf = (requested: string | null): string => {
    if (requested === null || requested.trim() === "") return OAUTH_SCOPE;
    const parts = requested.split(/\s+/).filter(part => part !== "");
    if (parts.some(part => part !== OAUTH_SCOPE)) throw new OAuthError(OAuthErrorCode.InvalidScope, `The only scope this server issues is ${OAUTH_SCOPE}.`);
    return OAUTH_SCOPE;
  };
  const resourceOf = (requested: string | null | undefined): string => {
    const canonical = deps.resource().href;
    if (requested === null || requested === undefined || requested === "") return canonical;
    let normalized: string;
    try { normalized = new URL(requested).href; } catch { throw new OAuthError(OAuthErrorCode.InvalidTarget, "The resource is not an absolute URI."); }
    if (normalized !== canonical) throw new OAuthError(OAuthErrorCode.InvalidTarget, `This server only issues tokens for ${canonical}.`);
    return canonical;
  };

  function loginDependencies(session: AuthorizeSession): LoginDependencies {
    return {
      store: new SubjectRoutedStore(deps.sessionsDir, session),
      pending: new MemoryPendingLoginStore(session),
      createAuth: deps.createAuth,
      connect: deps.connect,
    };
  }

  /**
   * Errors are sent back to the client through the redirect, but only once the client and its
   * redirect_uri have both been checked against the registration. Before that point a failure renders
   * a page here: emitting `Location:` for an unverified redirect_uri is what makes an open redirector.
   */
  function redirectBack(response: ServerResponse, params: AuthorizeParams, extra: Record<string, string>): void {
    const target = new URL(params.redirectUri);
    for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    target.searchParams.set("iss", deps.origin().origin);
    response.writeHead(303, { location: target.href, "cache-control": "no-store", "content-length": "0" });
    response.end();
  }

  function authorizeGet(response: ServerResponse, url: URL): void {
    const query = url.searchParams;
    const clientId = query.get("client_id") ?? "";
    const client = deps.store.findClient(clientId);
    if (!client) { sendHtml(response, 400, errorPage("This client is not registered with the local Maccabi server. Reconnect it and try again.")); return; }
    const presented = query.get("redirect_uri") ?? "";
    const registered = client.redirectUris.find(candidate => matchesRegistered(candidate, presented));
    if (registered === undefined) { sendHtml(response, 400, errorPage("The redirect address does not match what this client registered. Nothing was sent anywhere.")); return; }

    const state = query.get("state");
    const params: AuthorizeParams = {
      clientId, redirectUri: presented, ...(state === null ? {} : { state }),
      codeChallenge: query.get("code_challenge") ?? "", resource: "", scope: "",
      clientLabel: client.clientName ?? "An MCP client",
    };
    try {
      if (query.get("response_type") !== "code") throw new OAuthError(OAuthErrorCode.UnsupportedResponseType, "Only the authorization code flow is supported.");
      // Never fall back to `plain`: a downgrade defeats PKCE entirely, so an absent or plain method is a refusal.
      if (query.get("code_challenge_method") !== "S256") throw new OAuthError(OAuthErrorCode.InvalidRequest, "code_challenge_method must be S256.");
      if (!CODE_CHALLENGE.test(params.codeChallenge)) throw new OAuthError(OAuthErrorCode.InvalidRequest, "code_challenge is missing or malformed.");
      params.resource = resourceOf(query.get("resource"));
      params.scope = scopeOf(query.get("scope"));
    } catch (error) {
      const oauth = error instanceof OAuthError ? error : new OAuthError(OAuthErrorCode.ServerError, "The authorization request could not be read.");
      redirectBack(response, params, { error: String(oauth.code), error_description: oauth.message });
      return;
    }
    const session = deps.sessions.create(params);
    if (!session) { redirectBack(response, params, { error: OAuthErrorCode.TemporarilyUnavailable, error_description: "This server is holding too many unfinished sign-ins. Try again in a few minutes." }); return; }
    sendHtml(response, 200, idPage(session.id, session.csrf, params.clientLabel), { "set-cookie": sessionCookie(session) });
  }

  async function authorizePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (body === null) { sendHtml(response, 413, errorPage("That form submission was too large to read.")); return; }
    const fields = new URLSearchParams(body);
    // The hidden field names the session and the cookie proves this browser was served it. A form
    // posted from elsewhere carries no cookie for /authorize, so it cannot answer for a session it
    // was never given. Nothing is cleared on the way out: the other tabs' cookies are still good.
    const session = deps.sessions.get(fields.get("session") ?? undefined);
    if (!session || !deps.sessions.checkCookie(session, request.headers.cookie) || !deps.sessions.checkCsrf(session, fields.get("csrf") ?? undefined)) {
      sendHtml(response, 400, errorPage("This sign-in form expired or did not come from this page. Start again from your MCP client."));
      return;
    }
    const step = fields.get("step");
    const deps_ = loginDependencies(session);
    const render = (error?: string): void => {
      if (session.phase === "phone") sendHtml(response, 200, phonePage(session.id, session.csrf, session.phones ?? [], error));
      else if (session.phase === "otp") sendHtml(response, 200, otpPage(session.id, session.csrf, session.phoneLabel ?? "your phone", error));
      else sendHtml(response, 200, idPage(session.id, session.csrf, session.params.clientLabel, error));
    };
    try {
      if (step === "id" || step === "phone") {
        const memberId = step === "id" ? (fields.get("id") ?? "") : session.memberId ?? "";
        const option = step === "phone" ? Number(fields.get("phone")) : undefined;
        if (step === "phone" && (session.phase !== "phone" || !Number.isSafeInteger(option))) { render("Pick one of the listed numbers."); return; }
        if (!deps.sessions.takeSmsSlot()) { render("Too many sign-in attempts in the last minute. Wait a moment before trying again; repeated SMS requests lock the Maccabi account."); return; }
        const started = await startLogin(deps_, memberId, option);
        session.memberId = memberId;
        if (started.status === "phone-required") { session.phase = "phone"; session.phones = started.phones; render(); return; }
        session.phase = "otp"; session.phoneLabel = started.phone; render(); return;
      }
      if (step === "otp") {
        if (session.phase !== "otp") { render("Start the sign-in again."); return; }
        await verifyLogin(deps_, fields.get("code") ?? "");
        const subject = session.subject;
        if (subject === undefined) throw new Error("The completed login did not record a subject.");
        const code = await deps.store.issueCode({
          clientId: session.params.clientId, redirectUri: session.params.redirectUri, resource: session.params.resource,
          codeChallenge: session.params.codeChallenge, subject, scope: session.params.scope,
        });
        await deps.store.touchClient(session.params.clientId);
        deps.sessions.delete(session.id);
        response.setHeader("set-cookie", clearedCookie(session.id));
        redirectBack(response, session.params, { code });
        return;
      }
      sendHtml(response, 400, errorPage("That form step is not recognised."));
    } catch (error) {
      // One code per SMS: verifyLogin already deleted the challenge, so the member restarts from the
      // member ID rather than retyping a code against a challenge that no longer exists.
      session.phase = "id";
      session.pending = null;
      render(loginMessage(error));
    }
  }

  async function token(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const body = await readBody(request);
    if (body === null) { sendOAuthError(response, path, new OAuthError(OAuthErrorCode.InvalidRequest, "The request body was too large.")); return; }
    const fields = new URLSearchParams(body);
    const clientId = fields.get("client_id") ?? "";
    try {
      if (!deps.store.findClient(clientId)) throw new OAuthError(OAuthErrorCode.InvalidClient, "This client is not registered with this server.");
      const grantType = fields.get("grant_type");
      let issued;
      if (grantType === "authorization_code") {
        const grant = await deps.store.redeemCode(fields.get("code") ?? "", {
          clientId, redirectUri: fields.get("redirect_uri") ?? "", codeVerifier: fields.get("code_verifier") ?? "",
          resource: resourceOf(fields.get("resource")),
        });
        issued = await deps.store.issueTokens({ clientId, subject: grant.subject, resource: grant.resource, scope: grant.scope });
      } else if (grantType === "refresh_token") {
        const requested = fields.get("resource");
        issued = await deps.store.rotateRefresh(fields.get("refresh_token") ?? "", { clientId, ...(requested === null ? {} : { resource: resourceOf(requested) }) });
      } else {
        throw new OAuthError(OAuthErrorCode.UnsupportedGrantType, "Supported grant types are authorization_code and refresh_token.");
      }
      await deps.store.touchClient(clientId);
      sendJson(response, 200, {
        access_token: issued.accessToken, token_type: "Bearer", expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken, scope: issued.scope,
      });
    } catch (error) { sendOAuthError(response, path, error); }
  }

  const clientMetadataSchema = z.object({
    redirect_uris: z.array(z.string()).min(1).max(8),
    client_name: z.string().max(200).optional(),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    scope: z.string().optional(),
  });
  const SUPPORTED_GRANTS = ["authorization_code", "refresh_token"];

  async function register(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const body = await readBody(request);
    if (body === null) { sendOAuthError(response, path, new OAuthError(OAuthErrorCode.InvalidClientMetadata, "The registration body was too large.")); return; }
    try {
      let parsed;
      try { parsed = clientMetadataSchema.parse(JSON.parse(body)); }
      catch { throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, "The client metadata is not a usable RFC 7591 registration request."); }
      // Checked here and again at /authorize with the stored value: registration narrows what can ever
      // be presented, and the authorize-time check is what actually gates the Location header.
      const rejected = parsed.redirect_uris.find(uri => !isRegistrableRedirect(uri));
      if (rejected !== undefined) throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, "Redirect URIs must be http loopback addresses with no query or fragment, or one of the two allowed vscode.dev redirects.");
      if (parsed.token_endpoint_auth_method !== undefined && parsed.token_endpoint_auth_method !== "none") throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, "This server issues public clients only; token_endpoint_auth_method must be none.");
      if (parsed.grant_types?.some(grant => !SUPPORTED_GRANTS.includes(grant))) throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, "Supported grant types are authorization_code and refresh_token.");
      if (parsed.response_types?.some(type => type !== "code")) throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, "The only supported response type is code.");
      if (parsed.scope !== undefined) scopeOf(parsed.scope);
      const client = await deps.store.registerClient(parsed.redirect_uris, parsed.client_name);
      sendJson(response, 201, {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.issuedAt / 1000),
        redirect_uris: client.redirectUris,
        ...(client.clientName === undefined ? {} : { client_name: client.clientName }),
        token_endpoint_auth_method: "none",
        grant_types: SUPPORTED_GRANTS,
        response_types: ["code"],
        scope: OAUTH_SCOPE,
      });
    } catch (error) { sendOAuthError(response, path, error); }
  }

  async function revoke(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const body = await readBody(request);
    if (body === null) { sendOAuthError(response, path, new OAuthError(OAuthErrorCode.InvalidRequest, "The request body was too large.")); return; }
    const fields = new URLSearchParams(body);
    const presented = fields.get("token");
    if (presented === null) { sendOAuthError(response, path, new OAuthError(OAuthErrorCode.InvalidRequest, "token is required.")); return; }
    // RFC 7009: an unknown token is still a success, so revocation never doubles as a token oracle.
    await deps.store.revokeToken(presented);
    sendJson(response, 200, {});
  }

  const fail = (response: ServerResponse, path: string, error: unknown): void => {
    if (!response.headersSent) { sendOAuthError(response, path, error); return; }
    process.stderr.write(`Maccabi OAuth ${path} failed after the response had started: ${reasonOf(error)}\n`);
    response.end();
  };

  return (request, response, url) => {
    const path = url.pathname;
    if (path !== AUTHORIZE_PATH && path !== TOKEN_PATH && path !== REGISTER_PATH && path !== REVOKE_PATH) return false;
    const method = request.method ?? "GET";
    if (path === AUTHORIZE_PATH) {
      if (method === "GET") { try { authorizeGet(response, url); } catch (error) { fail(response, path, error); } return true; }
      if (method === "POST") { void authorizePost(request, response).catch(error => fail(response, path, error)); return true; }
      response.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" });
      response.end();
      return true;
    }
    if (method !== "POST") {
      response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      response.end();
      return true;
    }
    const handler = path === TOKEN_PATH ? token : path === REGISTER_PATH ? register : revoke;
    void handler(request, response, path).catch(error => fail(response, path, error));
    return true;
  };
}
