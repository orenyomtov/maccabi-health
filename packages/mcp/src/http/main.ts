import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import {
  bearerAuthChallengeResponse, createMcpHandler, getOAuthProtectedResourceMetadataUrl, oauthMetadataResponse,
  verifyBearerToken, type AuthInfo, type AuthMetadataOptions, type McpHttpHandler, type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { configDirectory, FileSessionStore } from "@maccabi/cli/store";
import { fileLoginDependencies, LoginError, type LoginDependencies, type LoginHandle } from "@maccabi/cli/login";
import { LOCAL_HTTP_PORT } from "../port";
import { createMaccabiMcpServer, serialExecutor, type Executor, type MaccabiMcpOptions } from "../tools";
import { AuthorizeSessions, HTTP_REAUTH_INSTRUCTION, subjectSessionResolver } from "./oauth/login-session";
import { buildAuthMetadata, OAUTH_SCOPE, WELL_KNOWN_PREFIX } from "./oauth/metadata";
import { createOAuthRouter, writeWebResponse } from "./oauth/router";
import { OAuthStore } from "./oauth/store";
import { credentialPath } from "./oauth/subject";
import { createTokenVerifier, subjectFrom } from "./oauth/verifier";

export const LOCAL_HTTP_HOST = "127.0.0.1";
export { LOCAL_HTTP_PORT };
export const LOCAL_HTTP_PATH = "/mcp";

export interface LocalHttpMcpHandle {
  readonly host: typeof LOCAL_HTTP_HOST;
  readonly port: number;
  readonly url: URL;
  close(): Promise<void>;
}

export interface LocalHttpMcpOptions {
  /** What `--port N` / `MACCABI_MCP_PORT` resolve to; `LOCAL_HTTP_PORT` when neither is set. Tests pass 0 for an ephemeral port. */
  port?: number;
  mcp?: Partial<MaccabiMcpOptions>;
  /** Test seam; holds oauth.json and the per-member sessions directory. */
  configDir?: string;
  /** Test seam for the upstream half of the browser sign-in. */
  login?: Pick<LoginDependencies, "createAuth" | "connect">;
}

function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

/** Starts the zero-config, loopback-only Streamable HTTP MCP endpoint and the OAuth server in front of it. */
export async function startLocalHttpMcp(options: LocalHttpMcpOptions = {}): Promise<LocalHttpMcpHandle> {
  const configDir = options.configDir ?? configDirectory();
  const sessionsDir = join(configDir, "sessions");
  const oauth = await OAuthStore.open(join(configDir, "oauth.json"));
  const sessions = new AuthorizeSessions();

  // The SDK builds a fresh server per HTTP request, so an executor created inside the factory below
  // would serialize nothing. This map lives for the lifetime of the handle instead, one executor per
  // authenticated subject: one member's calls never overlap, and two members never queue behind each other.
  const executors = new Map<string, Executor>();
  const executorFor = (subject: string): Executor => work => {
    let executor = executors.get(subject);
    if (!executor) executors.set(subject, executor = serialExecutor());
    return executor(work);
  };

  const subjectLogin = (subject: string): LoginHandle => {
    const credentials = new FileSessionStore(credentialPath(sessionsDir, subject));
    const browserOnly = async (): Promise<never> => {
      throw new LoginError("LOGIN_IS_BROWSER_ONLY", "This server signs in through the member's browser. Retry the read and let the MCP client run authorization again.");
    };
    return {
      start: browserOnly, verify: browserOnly,
      async status() { return await credentials.load() ? { status: "signed-in" } : { status: "signed-out" }; },
      // Both halves, always. A revoked credential with a live token strands the client: every read
      // answers REAUTHENTICATION_REQUIRED and nothing is left that can make it authorize again.
      async logout() { await credentials.delete(); await oauth.revokeSubject(subject); return { status: "local-session-removed" }; },
    };
  };

  // Every URL this server publishes embeds the bound port, which `port: 0` only settles once the
  // socket is listening, so the discovery documents and the verifier are built down there.
  let live: { origin: URL; resource: URL; metadata: AuthMetadataOptions; verifier: OAuthTokenVerifier } | null = null;
  const notListening = (): never => { throw new Error("The local MCP HTTP server is not listening yet."); };
  const origin = (): URL => live?.origin ?? notListening();
  const resource = (): URL => live?.resource ?? notListening();

  const handler: McpHttpHandler = createMcpHandler(
    context => {
      // The bearer gate below runs first, so every server instance is built for one verified member.
      const subject = subjectFrom(context.authInfo);
      return createMaccabiMcpServer({
        resolveSession: subjectSessionResolver(sessionsDir, subject, () => oauth.revokeSubject(subject)),
        runExclusive: executorFor(subject),
        login: subjectLogin(subject),
        loginTools: "status-only",
        reauthentication: { instruction: HTTP_REAUTH_INSTRUCTION },
        ...options.mcp,
      });
    },
    {
      legacy: "stateless",
      onerror: () => process.stderr.write("Maccabi MCP request failed.\n"),
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: () => process.stderr.write("Maccabi MCP HTTP transport failed.\n"),
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const upstream = options.login ?? fileLoginDependencies();
  const router = createOAuthRouter({
    store: oauth, sessions, sessionsDir, origin, resource,
    createAuth: upstream.createAuth, connect: upstream.connect,
  });

  const server = createServer((request, response) => {
    if (!validateHost(request, response)) return;
    if (!live) { response.writeHead(503, { "cache-control": "no-store" }); response.end(); return; }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? LOCAL_HTTP_HOST}`);
    if (url.pathname.startsWith(WELL_KNOWN_PREFIX)) {
      // Answered ahead of the Origin guard on purpose: a browser-based MCP client has to read these
      // two public documents cross-origin before it holds anything it could authenticate with.
      const probe = new Request(new URL(url.pathname, live.origin), { method: request.method ?? "GET" });
      const document = oauthMetadataResponse(probe, live.metadata);
      if (document) { writeWebResponse(response, document); return; }
    }
    if (!validateOrigin(request, response)) return;
    if (router(request, response, url)) return;
    if (url.pathname !== LOCAL_HTTP_PATH) {
      response.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.\n");
      return;
    }
    const challenge = { requiredScopes: [OAUTH_SCOPE], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(live.resource) };
    // verifyBearerToken rather than requireBearerAuth: the latter takes a web Request, and building
    // one here would drain the Node body stream that toNodeHandler still has to read the POST from.
    void verifyBearerToken(request.headers.authorization, { verifier: live.verifier, ...challenge })
      .then(authInfo => {
        (request as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
        response.setHeader("cache-control", "no-store");
        return nodeHandler(request, response);
      })
      .catch(error => writeWebResponse(response, bearerAuthChallengeResponse(error, challenge)));
  });

  const requestedPort = options.port ?? LOCAL_HTTP_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, LOCAL_HTTP_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(async error => {
    await handler.close().catch(() => undefined);
    throw error;
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeNodeServer(server).catch(() => undefined);
    await handler.close().catch(() => undefined);
    throw new Error("Local MCP HTTP server did not expose a TCP address.");
  }
  const port = address.port;
  const boundOrigin = new URL(`http://${LOCAL_HTTP_HOST}:${port}`);
  const boundResource = new URL(`http://${LOCAL_HTTP_HOST}:${port}${LOCAL_HTTP_PATH}`);
  live = {
    origin: boundOrigin, resource: boundResource,
    metadata: buildAuthMetadata(boundOrigin, boundResource),
    verifier: createTokenVerifier(oauth, boundResource),
  };
  return {
    host: LOCAL_HTTP_HOST,
    port,
    url: boundResource,
    async close() {
      await closeNodeServer(server);
      await handler.close();
      await oauth.flush().catch(() => undefined);
      executors.clear();
    },
  };
}
