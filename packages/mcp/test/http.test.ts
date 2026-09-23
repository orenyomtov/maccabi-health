import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ReauthenticationRequired, UpstreamError, type MaccabiSession, type PendingLogin } from "@maccabi/core";
import type { LoginAuthDriver, LoginDependencies } from "@maccabi/cli/login";
import { startLocalHttpMcp, type LocalHttpMcpHandle, type LocalHttpMcpOptions } from "../src/http/main";

const OTP = "123456";
const MEMBER = "012345678";
const OTHER_MEMBER = "087654321";
const LOOPBACK_REDIRECT = "http://localhost:7331/callback";
const synthetic: MaccabiSession = {
  version: 1, authenticatedAt: "2026-01-01T00:00:00.000Z",
  cookies: { version: "tough-cookie@6.0.2", storeType: "MemoryCookieStore", rejectPublicSuffixes: true, cookies: [] },
};
/** Two SMS-capable numbers, so every sign-in below walks the full id, phone and otp steps. */
const PHONES = [
  { index: 0, label: "Phone ending 12", display: "ending 12", smsAvailable: true },
  { index: 3, label: "Phone ending 78", display: "ending 78", smsAvailable: true },
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Every upstream call in this file stops here, so no test can reach a Maccabi host. */
function fakeUpstream() {
  const calls: string[] = [];
  const smsTo: (number | undefined)[] = [];
  const createAuth = (): LoginAuthDriver => {
    let memberId = 0;
    return {
      async beginLogin(id) { memberId = Number(id); calls.push("begin"); return { id: `challenge-${id}`, phones: PHONES.map(phone => ({ ...phone })) }; },
      async requestOtp(_id, phoneIndex) { calls.push("sms"); smsTo.push(phoneIndex); },
      async completeLogin(_id, otp) {
        calls.push("verify");
        if (otp !== OTP) throw new UpstreamError("OTP_REJECTED");
        return synthetic;
      },
      async exportPending(): Promise<PendingLogin> {
        return {
          version: 1, id: `challenge-${memberId}`, memberId, senderJwt: "synthetic.sender.jwt", validatorJwt: "synthetic.validator.jwt",
          phones: PHONES.map(phone => ({ ...phone })), expiresAt: Date.now() + 600_000, cookies: synthetic.cookies,
        };
      },
      restorePending(pending) { memberId = pending.memberId; },
      async cancelLogin() { calls.push("cancel"); },
    };
  };
  const connect: LoginDependencies["connect"] = async (session, expectedOwner) => ({
    readers: { currentOwner: { memberId: expectedOwner?.memberId ?? 0, memberIdCode: "0" } },
    exportSession: async () => session,
  });
  return { login: { createAuth, connect }, calls, smsTo };
}

async function start(overrides: Partial<LocalHttpMcpOptions> = {}) {
  const configDir = await mkdtemp(join(tmpdir(), "maccabi-http-"));
  const upstream = fakeUpstream();
  const handle = await startLocalHttpMcp({ port: 0, configDir, login: upstream.login, ...overrides });
  cleanups.push(async () => {
    await handle.close();
    await rm(configDir, { recursive: true, force: true });
  });
  return { handle, configDir, ...upstream };
}

function rawStatus(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", ...headers } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end("{}");
  });
}

/** A GET with exactly the headers given, so "no Origin header at all" can be stated rather than assumed. */
function rawGet(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "GET", headers }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
function hidden(html: string, name: string): string {
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
}
function cookieOf(response: Response): string {
  const header = response.headers.getSetCookie()[0] ?? response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}
function authorizeUrl(handle: LocalHttpMcpHandle, query: Record<string, string>): URL {
  const url = new URL("/authorize", handle.url);
  url.search = new URLSearchParams(query).toString();
  return url;
}
function authorizeQuery(handle: LocalHttpMcpHandle, clientId: string, challenge: string, redirectUri = LOOPBACK_REDIRECT): Record<string, string> {
  return {
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: "S256", state: "state-1", resource: handle.url.href, scope: "maccabi",
  };
}
function postForm(handle: LocalHttpMcpHandle, cookie: string, fields: Record<string, string>): Promise<Response> {
  return fetch(new URL("/authorize", handle.url), {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(fields).toString(),
  });
}
async function registerClient(handle: LocalHttpMcpHandle, metadata: Record<string, unknown>) {
  const response = await fetch(new URL("/register", handle.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(metadata),
  });
  return { status: response.status, body: await response.json() as Record<string, string> };
}
async function postToken(handle: LocalHttpMcpHandle, fields: Record<string, string>) {
  const response = await fetch(new URL("/token", handle.url), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, body: await response.json() as Record<string, string> };
}

/** The browser half: the authorization page and its three form posts, driven the way a member would. */
async function browserSignIn(handle: LocalHttpMcpHandle, clientId: string, options: { memberId?: string; code?: string; redirectUri?: string } = {}) {
  const { verifier, challenge } = pkce();
  const redirectUri = options.redirectUri ?? LOOPBACK_REDIRECT;
  const page = await fetch(authorizeUrl(handle, authorizeQuery(handle, clientId, challenge, redirectUri)));
  expect(page.status).toBe(200);
  const cookie = cookieOf(page);
  const html = await page.text();
  const form = { session: hidden(html, "session"), csrf: hidden(html, "csrf") };
  const phone = await postForm(handle, cookie, { ...form, step: "id", id: options.memberId ?? MEMBER });
  expect(await phone.text()).toContain("Where should the code go?");
  const otp = await postForm(handle, cookie, { ...form, step: "phone", phone: "1" });
  expect(await otp.text()).toContain("Enter the code");
  const done = await postForm(handle, cookie, { ...form, step: "otp", code: options.code ?? OTP });
  return { response: done, cookie, form, verifier, redirectUri };
}

/** Register, sign in and redeem the code: the shortest path to a usable bearer token. */
async function tokenFor(handle: LocalHttpMcpHandle, options: { memberId?: string } = {}) {
  const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT], client_name: "Test client" });
  const clientId = client["client_id"]!;
  const { response, verifier, redirectUri } = await browserSignIn(handle, clientId, options);
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!);
  const issued = await postToken(handle, {
    grant_type: "authorization_code", code: location.searchParams.get("code")!, client_id: clientId,
    redirect_uri: redirectUri, code_verifier: verifier, resource: handle.url.href,
  });
  expect(issued.status).toBe(200);
  return { clientId, location, accessToken: issued.body["access_token"]!, refreshToken: issued.body["refresh_token"]! };
}

async function connectClient(handle: LocalHttpMcpHandle, accessToken: string, name = "local-http-test") {
  const client = new Client({ name, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(handle.url, { authProvider: { token: async () => accessToken } }));
  cleanups.push(() => client.close());
  return client;
}

describe("loopback OAuth discovery and the bearer gate", () => {
  test("publishes both discovery documents at the bound port", async () => {
    const { handle } = await start();
    const resource = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", handle.url));
    expect(resource.status).toBe(200);
    const resourceDocument = await resource.json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    expect(resourceDocument.resource).toBe(handle.url.href);
    expect(resourceDocument.authorization_servers).toEqual([handle.url.origin]);
    expect(resourceDocument.scopes_supported).toEqual(["maccabi"]);

    const server = await fetch(new URL("/.well-known/oauth-authorization-server", handle.url));
    expect(server.status).toBe(200);
    const serverDocument = await server.json() as Record<string, unknown>;
    expect(serverDocument["issuer"]).toBe(handle.url.origin);
    expect(serverDocument["authorization_endpoint"]).toBe(`${handle.url.origin}/authorize`);
    expect(serverDocument["registration_endpoint"]).toBe(`${handle.url.origin}/register`);
    // A conforming MCP client refuses to start the flow unless S256 is advertised here.
    expect(serverDocument["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(serverDocument["authorization_response_iss_parameter_supported"]).toBe(true);
  });

  test("an unauthenticated MCP request answers 401 and points at the resource metadata", async () => {
    const { handle } = await start();
    const variants: Record<string, string>[] = [{}, { authorization: "Bearer not-a-real-token" }];
    for (const headers of variants) {
      const response = await fetch(handle.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain("Bearer");
      expect(challenge).toContain(`resource_metadata="${handle.url.origin}/.well-known/oauth-protected-resource/mcp"`);
    }
  });

  test("rejects non-local Host and Origin headers before MCP handling", async () => {
    const { handle } = await start();
    const rejected: Record<string, string>[] = [{ host: "attacker.example" }, { origin: "https://attacker.example" }];
    for (const headers of rejected) {
      expect(await rawStatus(handle.url, headers)).toBe(403);
    }
  });

  /**
   * The discovery documents are public, but they are not anonymous: they name this server, so any
   * page the member visits could fetch one and learn that its visitor is a Maccabi member. They used
   * to answer ahead of the Origin guard for the sake of a browser-based MCP client, and no other
   * route here carries CORS, so no such client could have completed the flow regardless.
   */
  test("the discovery documents sit behind the Origin guard and stay reachable without one", async () => {
    const { handle } = await start();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) {
      const url = new URL(path, handle.url);
      expect(await rawGet(url, { origin: "https://attacker.example" })).toBe(403);
      // curl, and every native MCP client, sends no Origin at all. That has to keep working.
      expect(await rawGet(url, {})).toBe(200);
      // A genuinely local caller is still allowed to name itself.
      expect(await rawGet(url, { origin: handle.url.origin })).toBe(200);
    }
  });

  test("serves only the fixed MCP path", async () => {
    const { handle } = await start();
    const response = await fetch(new URL("/", handle.url));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  // A request target starting `//` re-parses as an authority, so `http://127.0.0.1:PORT//%/mcp` — a URL
  // any web page can hand to fetch or an <img> — used to throw out of the request callback and end the
  // process. The Origin guard never got to run, because the throw happened before it.
  test("a request target node accepts but WHATWG URL refuses answers 400 instead of ending the process", async () => {
    const { handle } = await start();
    for (const target of ["//%/mcp", "//%2f/x", "//[/x", "//a%00b/x"]) {
      const response = await fetch(`${handle.url.origin}${target}`);
      expect(response.status).toBe(400);
    }
    // Still serving afterwards.
    expect((await fetch(new URL("/.well-known/oauth-authorization-server", handle.url))).status).toBe(200);
  });

  // `new Request` refuses the fetch-spec forbidden methods, and the discovery documents build one.
  test("a forbidden HTTP method on a discovery path answers 400 instead of ending the process", async () => {
    const { handle } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(new URL("/.well-known/oauth-authorization-server", handle.url), { method: "TRACE" }, response => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(400);
    expect((await fetch(new URL("/.well-known/oauth-authorization-server", handle.url))).status).toBe(200);
  });
});

describe("browser authorization", () => {
  test("registration, the three sign-in steps and the code exchange produce a working token", async () => {
    const { handle, calls, smsTo, configDir } = await start();
    const { location, accessToken } = await tokenFor(handle);

    expect(location.origin + location.pathname).toBe(LOOPBACK_REDIRECT);
    expect(location.searchParams.get("state")).toBe("state-1");
    // RFC 9207: the client checks this before it will redeem the code.
    expect(location.searchParams.get("iss")).toBe(handle.url.origin);
    expect(calls).toEqual(["begin", "begin", "sms", "verify"]);
    // Option 1 is upstream index 0, and one SMS went out, not one per form post.
    expect(smsTo).toEqual([0]);
    expect(await readdir(join(configDir, "sessions"))).toHaveLength(1);

    const client = await connectClient(handle, accessToken);
    const { tools } = await client.listTools();
    // Two fewer than stdio: the browser leg replaces maccabi_login_start and maccabi_login_verify.
    expect(tools).toHaveLength(36);
    expect(tools.map(tool => tool.name)).not.toContain("maccabi_login_start");
    expect(tools.map(tool => tool.name)).not.toContain("maccabi_login_verify");
  });

  test("a loopback redirect matches on everything but the port", async () => {
    const { handle } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: ["http://localhost/callback"], client_name: "Port-varying client" });
    const page = await fetch(authorizeUrl(handle, authorizeQuery(handle, client["client_id"]!, pkce().challenge, "http://localhost:51234/callback")));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Sign in to Maccabi");
  });

  test("registration refuses redirect targets that are not loopback or an allowed vscode.dev URI", async () => {
    const { handle } = await start();
    for (const uri of ["https://evil.example/steal", "http://127.0.0.1/cb?next=https://evil.example", "http://evil.example/cb", "https://vscode.dev/redirect/../../evil"]) {
      const { status, body } = await registerClient(handle, { redirect_uris: [uri] });
      expect(status).toBe(400);
      expect(body["error"]).toBe("invalid_redirect_uri");
    }
    expect((await registerClient(handle, { redirect_uris: ["https://vscode.dev/redirect"] })).status).toBe(201);
  });
});

describe("open redirector defence", () => {
  test("an unmatched redirect_uri or unknown client renders a page and emits no Location header", async () => {
    const { handle } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT] });
    const attempts = [
      authorizeQuery(handle, client["client_id"]!, pkce().challenge, "https://evil.example/steal"),
      authorizeQuery(handle, client["client_id"]!, pkce().challenge, "http://localhost:7331/other"),
      authorizeQuery(handle, "not-a-registered-client", pkce().challenge),
    ];
    for (const query of attempts) {
      const response = await fetch(authorizeUrl(handle, query), { redirect: "manual" });
      expect(response.status).toBe(400);
      // The whole point: nothing sends the browser anywhere until the client and its URI both check out.
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("Sign-in stopped");
    }
  });

  test("a request that fails after the redirect checks reports the error through the redirect", async () => {
    const { handle } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT] });
    const query = authorizeQuery(handle, client["client_id"]!, pkce().challenge);
    const response = await fetch(authorizeUrl(handle, { ...query, resource: "http://127.0.0.1:1/elsewhere" }), { redirect: "manual" });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(LOOPBACK_REDIRECT);
    expect(location.searchParams.get("error")).toBe("invalid_target");
    expect(location.searchParams.get("state")).toBe("state-1");
  });
});

describe("PKCE and form integrity", () => {
  test("S256 cannot be downgraded or omitted", async () => {
    const { handle } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT] });
    const { challenge } = pkce();
    const base = authorizeQuery(handle, client["client_id"]!, challenge);
    const broken: Record<string, string>[] = [
      { ...base, code_challenge_method: "plain" },
      { ...base, code_challenge_method: "" },
      { ...base, code_challenge: "too-short" },
      { ...base, code_challenge: "" },
      { ...base, response_type: "token" },
    ];
    for (const query of broken) {
      const response = await fetch(authorizeUrl(handle, query), { redirect: "manual" });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).not.toBeNull();
    }
  });

  test("the token endpoint refuses a code redeemed with the wrong verifier", async () => {
    const { handle } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT], client_name: "Test client" });
    const clientId = client["client_id"]!;
    const { response } = await browserSignIn(handle, clientId);
    const code = new URL(response.headers.get("location")!).searchParams.get("code")!;

    const wrong = await postToken(handle, {
      grant_type: "authorization_code", code, client_id: clientId,
      redirect_uri: LOOPBACK_REDIRECT, code_verifier: pkce().verifier, resource: handle.url.href,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body["error"]).toBe("invalid_grant");
  });

  test("a form post without the session cookie or with a wrong CSRF token is refused", async () => {
    const { handle, calls } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT] });
    const page = await fetch(authorizeUrl(handle, authorizeQuery(handle, client["client_id"]!, pkce().challenge)));
    const cookie = cookieOf(page);
    const html = await page.text();
    const form = { session: hidden(html, "session"), csrf: hidden(html, "csrf") };

    const forged = [
      { cookie: "", fields: { ...form, step: "id", id: MEMBER } },
      { cookie, fields: { ...form, csrf: "0".repeat(32), step: "id", id: MEMBER } },
      { cookie, fields: { ...form, session: "0".repeat(32), step: "id", id: MEMBER } },
    ];
    for (const attempt of forged) {
      const response = await postForm(handle, attempt.cookie, attempt.fields);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Sign-in stopped");
    }
    // Nothing reached upstream, so no SMS was sent on behalf of a form we did not serve.
    expect(calls).toEqual([]);
  });

  test("repeated first steps hit the SMS limiter before they can lock the account", async () => {
    const { handle, calls } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT] });
    const page = await fetch(authorizeUrl(handle, authorizeQuery(handle, client["client_id"]!, pkce().challenge)));
    const cookie = cookieOf(page);
    const html = await page.text();
    const form = { session: hidden(html, "session"), csrf: hidden(html, "csrf") };

    const bodies: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      bodies.push(await (await postForm(handle, cookie, { ...form, step: "id", id: MEMBER })).text());
    }
    expect(bodies.slice(0, 5).every(body => body.includes("Where should the code go?"))).toBe(true);
    expect(bodies[5]).toContain("Too many sign-in attempts");
    expect(calls.filter(call => call === "begin")).toHaveLength(5);
  });

  test("a wrong SMS code ends the challenge instead of offering a retry", async () => {
    const { handle, calls, configDir } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT] });
    const { response } = await browserSignIn(handle, client["client_id"]!, { code: "999999" });
    expect(response.status).toBe(200);
    const html = await response.text();
    // Back to the ID number, not back to the code box: the challenge is gone, so a retry would be a second SMS.
    expect(html).toContain("ID number");
    expect(calls).toContain("cancel");
    expect(await readdir(join(configDir, "sessions")).catch(() => [])).toHaveLength(0);
  });
});

describe("per-member isolation", () => {
  test("two members get separate credential files and tokens that cannot read each other", async () => {
    const owners: string[] = [];
    const { handle, configDir } = await start({
      // Only `connect` is overridden, so each request still resolves its own subject's saved session.
      mcp: {
        connect: async (_session, owner) => {
          owners.push(`${owner?.memberId}`);
          throw new ReauthenticationRequired();
        },
      },
    });
    const first = await tokenFor(handle, { memberId: MEMBER });
    const second = await tokenFor(handle, { memberId: OTHER_MEMBER });
    expect(first.accessToken).not.toBe(second.accessToken);
    expect(await readdir(join(configDir, "sessions"))).toHaveLength(2);

    for (const token of [first.accessToken, second.accessToken]) {
      const client = await connectClient(handle, token, `isolation-${token.slice(0, 6)}`);
      await client.callTool({ name: "maccabi_account", arguments: { section: "profile" } });
    }
    // Each token resolved its own member's saved session, never the other's.
    expect(owners).toEqual([Number(MEMBER).toString(), Number(OTHER_MEMBER).toString()]);
  });

  test("two browser sign-ins run at the same time without clobbering each other's challenge", async () => {
    // A single process-wide pending-login.json is what made this dangerous: the second start would
    // overwrite the first member's challenge, and answering it with their code locks the account.
    const { handle, configDir, calls } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT], client_name: "Test client" });
    const clientId = client["client_id"]!;

    const open = async () => {
      const { verifier, challenge } = pkce();
      const page = await fetch(authorizeUrl(handle, authorizeQuery(handle, clientId, challenge)));
      const html = await page.text();
      return { cookie: cookieOf(page), form: { session: hidden(html, "session"), csrf: hidden(html, "csrf") }, verifier };
    };
    const a = await open(), b = await open();
    expect(a.form.session).not.toBe(b.form.session);

    // Interleaved on purpose: every step of B lands between two steps of A.
    await postForm(handle, a.cookie, { ...a.form, step: "id", id: MEMBER });
    await postForm(handle, b.cookie, { ...b.form, step: "id", id: OTHER_MEMBER });
    await postForm(handle, a.cookie, { ...a.form, step: "phone", phone: "1" });
    await postForm(handle, b.cookie, { ...b.form, step: "phone", phone: "4" });
    const finishedA = await postForm(handle, a.cookie, { ...a.form, step: "otp", code: OTP });
    const finishedB = await postForm(handle, b.cookie, { ...b.form, step: "otp", code: OTP });

    expect(finishedA.status).toBe(303);
    expect(finishedB.status).toBe(303);
    const codeA = new URL(finishedA.headers.get("location")!).searchParams.get("code");
    const codeB = new URL(finishedB.headers.get("location")!).searchParams.get("code");
    expect(codeA).not.toBe(codeB);
    expect(calls.filter(call => call === "verify")).toHaveLength(2);
    // Two members signed in, so two credential files, not one overwritten twice.
    expect(await readdir(join(configDir, "sessions"))).toHaveLength(2);
  });

  test("calls serialize per member and not across members", async () => {
    let active = 0, peak = 0, resolved = 0;
    const { handle } = await start({
      mcp: {
        resolveSession: async () => {
          resolved++;
          peak = Math.max(peak, ++active);
          await new Promise(resolve => setTimeout(resolve, 30));
          active--;
          return null;
        },
      },
    });
    const first = await tokenFor(handle, { memberId: MEMBER });
    const client = await connectClient(handle, first.accessToken, "serial");
    // The SDK builds a new server per HTTP request, so the executor has to outlive the factory;
    // without that, overlapping calls each get their own mutex and race over the session file.
    const responses = await Promise.all([0, 1, 2].map(() => client.callTool({ name: "maccabi_account", arguments: { section: "profile" } })));
    expect(resolved).toBe(3);
    expect(peak).toBe(1);
    for (const response of responses) {
      expect((response as { structuredContent?: { error: { code: string } } }).structuredContent!.error.code).toBe("REAUTHENTICATION_REQUIRED");
    }

    active = 0; peak = 0;
    const second = await tokenFor(handle, { memberId: OTHER_MEMBER });
    const other = await connectClient(handle, second.accessToken, "serial-other");
    await Promise.all([client.callTool({ name: "maccabi_account", arguments: { section: "profile" } }), other.callTool({ name: "maccabi_account", arguments: { section: "profile" } })]);
    // One queue per member: a second member's read never waits behind the first member's.
    expect(peak).toBe(2);
  });
});

describe("re-authorization loop", () => {
  test("an invalidated session revokes the member's tokens so the client authorizes again", async () => {
    // Without the revocation half the member is stranded: every read answers REAUTHENTICATION_REQUIRED,
    // the client still holds a valid token, and nothing ever makes it run authorization again.
    const { handle, configDir } = await start({
      mcp: { connect: async () => { throw new ReauthenticationRequired(); } },
    });
    const { accessToken, refreshToken, clientId } = await tokenFor(handle);
    expect(await readdir(join(configDir, "sessions"))).toHaveLength(1);

    const client = await connectClient(handle, accessToken, "reauth");
    const response = await client.callTool({ name: "maccabi_account", arguments: { section: "profile" } });
    const error = (response as { structuredContent?: { error: { code: string; instruction: string } } }).structuredContent!.error;
    expect(error.code).toBe("REAUTHENTICATION_REQUIRED");
    expect(error.instruction).toContain("The access token has been revoked");
    // The Maccabi credential went first.
    expect(await readdir(join(configDir, "sessions"))).toHaveLength(0);

    // The OAuth token went with it, so the next request is a 401 that starts the flow over.
    const retry = await fetch(handle.url, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, body: "{}",
    });
    expect(retry.status).toBe(401);
    // And the refresh token cannot quietly mint a replacement.
    const refreshed = await postToken(handle, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    expect(refreshed.status).toBe(400);
    expect(refreshed.body["error"]).toBe("invalid_grant");
  });

  test("maccabi_logout revokes the member's tokens as well as the local credential", async () => {
    const { handle, configDir } = await start();
    const { accessToken } = await tokenFor(handle);
    const client = await connectClient(handle, accessToken, "logout");
    expect((await client.callTool({ name: "maccabi_login_status", arguments: {} }) as { structuredContent?: { status: string } }).structuredContent!.status).toBe("signed-in");

    await client.callTool({ name: "maccabi_logout", arguments: {} });
    expect(await readdir(join(configDir, "sessions"))).toHaveLength(0);
    const retry = await fetch(handle.url, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, body: "{}",
    });
    expect(retry.status).toBe(401);
  });
});

describe("token lifecycle", () => {
  test("refresh rotates, and replaying a spent refresh token revokes the member", async () => {
    const { handle } = await start();
    const { clientId, accessToken, refreshToken } = await tokenFor(handle);

    const rotated = await postToken(handle, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: handle.url.href });
    expect(rotated.status).toBe(200);
    expect(rotated.body["refresh_token"]).not.toBe(refreshToken);
    expect(rotated.body["access_token"]).not.toBe(accessToken);

    const replay = await postToken(handle, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    expect(replay.status).toBe(400);
    expect(replay.body["error"]).toBe("invalid_grant");
    // A replayed refresh token means it leaked, so everything this member holds goes, including the token just issued.
    for (const token of [accessToken, rotated.body["access_token"]!]) {
      const response = await fetch(handle.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
      expect(response.status).toBe(401);
    }
  });

  test("an authorization code is single use and bound to its client", async () => {
    const { handle } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT], client_name: "Test client" });
    const clientId = client["client_id"]!;
    const { response, verifier } = await browserSignIn(handle, clientId);
    const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
    const exchange = () => postToken(handle, {
      grant_type: "authorization_code", code, client_id: clientId, redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier, resource: handle.url.href,
    });
    expect((await exchange()).status).toBe(200);
    const replay = await exchange();
    expect(replay.status).toBe(400);
    expect(replay.body["error"]).toBe("invalid_grant");
  });

  test("revocation takes the member's access token out of service", async () => {
    const { handle } = await start();
    const { accessToken, refreshToken } = await tokenFor(handle);
    const revoked = await fetch(new URL("/revoke", handle.url), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    expect(revoked.status).toBe(200);
    const response = await fetch(handle.url, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, body: "{}",
    });
    expect(response.status).toBe(401);
    // RFC 7009: an unknown token is still a success, so revocation is not a token oracle.
    const unknown = await fetch(new URL("/revoke", handle.url), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "never-issued" }).toString(),
    });
    expect(unknown.status).toBe(200);
  });

  test("a token issued for another resource is refused", async () => {
    const { handle } = await start();
    const { body: client } = await registerClient(handle, { redirect_uris: [LOOPBACK_REDIRECT] });
    const query = authorizeQuery(handle, client["client_id"]!, pkce().challenge);
    const response = await fetch(authorizeUrl(handle, { ...query, resource: "https://someone-elses.example/mcp" }), { redirect: "manual" });
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});
