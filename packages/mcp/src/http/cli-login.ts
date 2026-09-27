import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MaccabiError } from "@maccabi/core";
import { LoginError, startLogin, verifyLogin, type LoginDependencies } from "@maccabi/cli/login";
import { SessionStoreError, type CredentialStore } from "@maccabi/cli/store";
import { AUTHORIZE_PATH } from "./oauth/metadata";

const LOCAL_HTTP_HOST = "127.0.0.1" as const;
import { donePage, errorPage, idPage, otpPage, PAGE_HEADERS, phonePage } from "./oauth/pages";
import {
  AuthorizeSessions, MemoryPendingLoginStore, clearedCookie, sessionCookie,
  type AuthorizeParams, type AuthorizeSession,
} from "./oauth/login-session";

export const CLI_LOGIN_TTL_MS = 10 * 60 * 1000;
const BODY_LIMIT = 16 * 1024;
const CLIENT_LABEL = "maccabi-health";
const RESTART_HINT = "Close this window and open the sign-in link again.";

export interface CliBrowserLoginHandle {
  readonly host: typeof LOCAL_HTTP_HOST;
  readonly port: number;
  /** Loopback URL the member opens (or that a tunnel should forward). */
  readonly url: URL;
  /** Resolves once the session file has been written. */
  readonly signedIn: Promise<void>;
  close(): Promise<void>;
}

export interface CliBrowserLoginOptions {
  port?: number;
  /** Writes the completed login to the CLI session file (`session.json`). */
  store: CredentialStore;
  createAuth: LoginDependencies["createAuth"];
  connect: LoginDependencies["connect"];
}

function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function sendHtml(response: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...PAGE_HEADERS, ...headers });
  response.end(html);
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function loginMessage(error: unknown): string {
  if (error instanceof LoginError) return error.message;
  if (error instanceof SessionStoreError) return "Protected storage could not be read or written. Check the permissions of the maccabi-health config directory, then try again.";
  if (error instanceof MaccabiError) return "The sign-in step did not complete. Start again; no code was resent and nothing was retried.";
  return "The sign-in step could not be completed.";
}

/** Placeholder OAuth fields; the CLI path never redirects or issues a code. */
function cliAuthorizeParams(): AuthorizeParams {
  return {
    clientId: "cli", redirectUri: "http://127.0.0.1/cli", codeChallenge: "x".repeat(43),
    resource: "cli", scope: "maccabi", clientLabel: CLIENT_LABEL,
  };
}

/**
 * Loopback browser sign-in for the CLI. Reuses the same HTML forms as MCP HTTP OAuth, but writes
 * the completed login to the caller's CredentialStore (the CLI `session.json`) and never touches
 * `sessions/<subject>.json` or oauth.json.
 */
export async function startCliBrowserLogin(options: CliBrowserLoginOptions): Promise<CliBrowserLoginHandle> {
  const sessions = new AuthorizeSessions();
  let resolveSignedIn!: () => void;
  const signedIn = new Promise<void>(resolve => { resolveSignedIn = resolve; });
  let finished = false;

  function loginDependencies(session: AuthorizeSession): LoginDependencies {
    return {
      store: options.store,
      pending: new MemoryPendingLoginStore(session),
      createAuth: options.createAuth,
      connect: options.connect,
    };
  }

  function begin(response: ServerResponse): void {
    const session = sessions.create(cliAuthorizeParams());
    if (!session) {
      sendHtml(response, 503, errorPage("Too many unfinished sign-ins. Try again in a few minutes.", RESTART_HINT));
      return;
    }
    sendHtml(response, 200, idPage(session.id, session.csrf, CLIENT_LABEL), { "set-cookie": sessionCookie(session) });
  }

  async function authorizePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (body === null) { sendHtml(response, 413, errorPage("That form submission was too large to read.", RESTART_HINT)); return; }
    const fields = new URLSearchParams(body);
    const session = sessions.get(fields.get("session") ?? undefined);
    if (!session || !sessions.checkCookie(session, request.headers.cookie) || !sessions.checkCsrf(session, fields.get("csrf") ?? undefined)) {
      sendHtml(response, 400, errorPage("This sign-in form expired or did not come from this page. Open the sign-in link again.", RESTART_HINT));
      return;
    }
    const step = fields.get("step");
    const deps = loginDependencies(session);
    const render = (error?: string): void => {
      if (session.phase === "phone") sendHtml(response, 200, phonePage(session.id, session.csrf, session.phones ?? [], error));
      else if (session.phase === "otp") sendHtml(response, 200, otpPage(session.id, session.csrf, session.phoneLabel ?? "your phone", error));
      else sendHtml(response, 200, idPage(session.id, session.csrf, CLIENT_LABEL, error));
    };
    try {
      if (step === "id" || step === "phone") {
        const memberId = step === "id" ? (fields.get("id") ?? "") : session.memberId ?? "";
        const option = step === "phone" ? Number(fields.get("phone")) : undefined;
        if (step === "phone" && (session.phase !== "phone" || !Number.isSafeInteger(option))) { render("Pick one of the listed numbers."); return; }
        if (!sessions.takeSmsSlot()) { render("Too many sign-in attempts in the last minute. Wait a moment before trying again; repeated SMS requests lock the Maccabi account."); return; }
        const started = await startLogin(deps, memberId, option);
        session.memberId = memberId;
        if (started.status === "phone-required") { session.phase = "phone"; session.phones = started.phones; render(); return; }
        session.phase = "otp"; session.phoneLabel = started.phone; render(); return;
      }
      if (step === "otp") {
        if (session.phase !== "otp") { render("Start the sign-in again."); return; }
        await verifyLogin(deps, fields.get("code") ?? "");
        sessions.delete(session.id);
        response.setHeader("set-cookie", clearedCookie(session.id));
        sendHtml(response, 200, donePage());
        if (!finished) { finished = true; resolveSignedIn(); }
        return;
      }
      sendHtml(response, 400, errorPage("That form step is not recognised.", RESTART_HINT));
    } catch (error) {
      session.phase = "id";
      session.pending = null;
      render(loginMessage(error));
    }
  }

  const server = createServer((request, response) => {
    try {
      const host = request.headers.host ?? `${LOCAL_HTTP_HOST}`;
      const url = new URL(request.url ?? "/", `http://${host}`);
      const method = request.method ?? "GET";
      if (url.pathname === "/" || url.pathname === AUTHORIZE_PATH) {
        if (method === "GET") { begin(response); return; }
        if (method === "POST" && url.pathname === AUTHORIZE_PATH) {
          void authorizePost(request, response).catch(() => {
            if (!response.headersSent) sendHtml(response, 500, errorPage("The sign-in step could not be completed.", RESTART_HINT));
            else response.end();
          });
          return;
        }
        response.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.\n");
    } catch {
      if (response.headersSent) { response.end(); return; }
      response.writeHead(400, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      response.end("Bad request.\n");
    }
  });

  const requestedPort = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, LOCAL_HTTP_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(error => { throw error; });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeNodeServer(server).catch(() => undefined);
    throw new Error("The browser login server did not expose a TCP address.");
  }
  const port = address.port;
  return {
    host: LOCAL_HTTP_HOST,
    port,
    url: new URL(`http://${LOCAL_HTTP_HOST}:${port}/`),
    signedIn,
    async close() {
      server.closeIdleConnections();
      await closeNodeServer(server).catch(() => undefined);
    },
  };
}
