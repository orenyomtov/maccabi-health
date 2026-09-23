import { describe, expect, test } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LOGIN_ORIGIN, MaccabiTransport, PORTAL_ORIGIN, VIEWER_ORIGIN, readResponseBody } from "../src/transport";
import { ReauthenticationRequired, UpstreamError } from "../src/errors";

/** A local synthetic HTTP peer, reached only through the injected fetch adapter. */
async function withStalledPeer(run: (transport: MaccabiTransport, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const peer = createServer((request, response) => {
    calls.push(request.url!);
    if (request.url === "/headers") return; // Never send response headers.
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/malformed") { response.end("{"); return; }
    response.write("{"); // Headers and initial bytes arrive, but the body never ends.
  });
  await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
  const port = (peer.address() as AddressInfo).port;
  const transport = new MaccabiTransport({
    // Keep the synthetic deadline short while allowing the local peer's callback to run
    // on a heavily loaded development host. The production default remains 30 seconds.
    timeoutMs: 1_000,
    fetch: (input, init) => fetch(`http://127.0.0.1:${port}${new URL(String(input)).pathname}`, init),
  });
  try { await run(transport, calls); }
  finally {
    peer.closeAllConnections();
    await new Promise<void>(resolve => peer.close(() => resolve()));
  }
}

describe("explicit network deadlines", () => {
  test("a peer that never sends headers times out without retrying", async () => {
    await withStalledPeer(async (transport, calls) => {
      await expect(transport.request("/headers")).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
      expect(calls).toEqual(["/headers"]);
    });
  });

  test("a stalled JSON body is a timeout, not malformed content", async () => {
    await withStalledPeer(async (transport, calls) => {
      await expect(transport.requestJson("/body")).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
      expect(calls).toEqual(["/body"]);
    });
  });

  test("the same deadline aborts native text and binary body consumption", async () => {
    await withStalledPeer(async (transport, calls) => {
      for (const method of ["text", "arrayBuffer"] as const) {
        const response = await transport.request("/body");
        await expect(readResponseBody<string | ArrayBuffer>(() => response[method](), new UpstreamError("INVALID_RESPONSE"))).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
      }
      expect(calls).toEqual(["/body", "/body"]);
    });
  });

  test("caller cancellation remains distinct from timeout", async () => {
    await withStalledPeer(async (transport) => {
      const controller = new AbortController();
      const response = await transport.request("/body", { signal: controller.signal });
      controller.abort();
      await expect(readResponseBody(() => response.text(), new UpstreamError("INVALID_RESPONSE"))).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    });
  });

  test("completed invalid JSON retains its original content error", async () => {
    await withStalledPeer(async (transport) => {
      await expect(transport.requestJson("/malformed")).rejects.toMatchObject({ code: "INVALID_JSON" });
    });
  });
});

describe("observed owner navigation cookie", () => {
  const owner = { memberId: 123456789, memberIdCode: "0" };

  test("first bootstrap creates only a secure root session cookie and later bootstrap values do not overwrite it", async () => {
    let calls = 0;
    const transport = new MaccabiTransport({ fetch: async () => { calls++; throw new Error("No request expected"); } });
    transport.markAuthenticated();
    expect(await transport.getOrCreatePortalNavigationSession(owner, "synthetic-first-session")).toBe("synthetic-first-session");
    expect(await transport.getOrCreatePortalNavigationSession(owner, "synthetic-new-bootstrap")).toBe("synthetic-first-session");
    const saved = await transport.exportSession();
    const cookies = saved.cookies.cookies;
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ key: "cookie_sessionId_0_123456789", value: "synthetic-first-session", path: "/", secure: true, hostOnly: true, domain: "online.maccabi4u.co.il" });
    expect(cookies[0]?.expires).toBeUndefined();
    expect(cookies[0]?.maxAge).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("saved exact-owner cookies survive reload and remain separate from other owner/code names", async () => {
    const first = new MaccabiTransport();
    first.markAuthenticated();
    await first.getOrCreatePortalNavigationSession(owner, "synthetic-owner-session");
    const restored = new MaccabiTransport({ session: await first.exportSession() });
    expect(await restored.getOrCreatePortalNavigationSession(owner, "")).toBe("synthetic-owner-session");
    expect(await restored.getOrCreatePortalNavigationSession({ memberId: 987654321, memberIdCode: "0" }, "synthetic-other-session")).toBe("synthetic-other-session");
    expect(await restored.getOrCreatePortalNavigationSession({ ...owner, memberIdCode: "1" }, "synthetic-code-session")).toBe("synthetic-code-session");
    expect(await restored.getOrCreatePortalNavigationSession(owner, "synthetic-new-bootstrap")).toBe("synthetic-owner-session");
  });

  test("invalid names and cookie values fail safely without storing a cookie", async () => {
    const transport = new MaccabiTransport();
    transport.markAuthenticated();
    for (const value of ["", "synthetic; injected=value", "synthetic\r\nsecret"]) {
      await expect(transport.getOrCreatePortalNavigationSession(owner, value)).rejects.toMatchObject({ code: "INVALID_NAVIGATION_SESSION" });
    }
    await expect(transport.getOrCreatePortalNavigationSession({ ...owner, memberIdCode: "0;secret" }, "synthetic")).rejects.toMatchObject({ code: "INVALID_NAVIGATION_SESSION" });
    expect((await transport.exportSession()).cookies.cookies).toHaveLength(0);
  });
});

describe("redirects the caller asked to handle itself", () => {
  test("a manual redirect is handed back even when it leaves the allowed origins", async () => {
    let calls = 0;
    const transport = new MaccabiTransport({ fetch: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://unrelated.example/next" } });
    } });
    const response = await transport.request(PORTAL_ORIGIN + "/sonline/synthetic/read", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://unrelated.example/next");
    expect(calls).toBe(1);
  });

  test("an expired session still dies on the expiry redirect a manual caller would otherwise be handed", async () => {
    const transport = new MaccabiTransport({ fetch: async () => new Response(null, { status: 302, headers: { location: "/my.policy" } }) });
    transport.markAuthenticated();
    await expect(transport.request(PORTAL_ORIGIN + "/sonline/synthetic/read", { redirect: "manual" })).rejects.toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
  });

  test("a malformed upstream location is a typed transport failure, not a raw TypeError", async () => {
    const transport = new MaccabiTransport({ fetch: async () => new Response(null, { status: 302, headers: { location: "http://" } }) });
    await expect(transport.request(PORTAL_ORIGIN + "/sonline/synthetic/read", { redirect: "manual" })).rejects.toMatchObject({ code: "INVALID_URL" });
  });

  /** A walker with no bound is the actual risk here, so the bound is pinned to its exact hop count. */
  test("an endless redirect chain stops at nine requests rather than walking for ever", async () => {
    let calls = 0;
    const transport = new MaccabiTransport({ fetch: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: `/sonline/synthetic/hop-${calls}` } });
    } });
    await expect(transport.request(PORTAL_ORIGIN + "/sonline/synthetic/read")).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    expect(calls).toBe(9);
  });
});

describe("credentials embedded in a URL", () => {
  /**
   * `new URL("https://a:b@online.maccabi4u.co.il/x").origin` is the allowed portal origin, so the
   * allowlist alone lets userinfo through and `url.href` then carries it onto the wire. Checked both
   * where a caller supplies it and where an upstream redirect does.
   */
  test("userinfo on an otherwise allowed origin is refused and never reaches fetch", async () => {
    const seen: string[] = [];
    const transport = new MaccabiTransport({ fetch: async input => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: "https://synthetic-user:synthetic-secret@online.maccabi4u.co.il/sonline/next" } });
    } });
    await expect(transport.request("https://synthetic-user:synthetic-secret@online.maccabi4u.co.il/sonline/read"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_ORIGIN" });
    expect(seen).toEqual([]);
    await expect(transport.request(PORTAL_ORIGIN + "/sonline/read")).rejects.toMatchObject({ code: "UNSUPPORTED_ORIGIN" });
    expect(seen).toEqual([PORTAL_ORIGIN + "/sonline/read"]);
    expect(seen.join(" ")).not.toContain("synthetic-secret");
  });
});

describe("which hop counts as an authenticated portal request", () => {
  /** The hole the initial-URL reading left: the chain only reaches the portal on its second hop. */
  test("a chain that starts on the login host and is redirected onto the portal still dies on the expiry redirect", async () => {
    const seen: string[] = [];
    const transport = new MaccabiTransport({ fetch: async input => {
      const href = String(input);
      seen.push(href);
      return href.startsWith(LOGIN_ORIGIN)
        ? new Response(null, { status: 302, headers: { location: PORTAL_ORIGIN + "/sonline/synthetic/read" } })
        : new Response(null, { status: 302, headers: { location: PORTAL_ORIGIN + "/my.policy" } });
    } });
    transport.markAuthenticated();
    await expect(transport.request(LOGIN_ORIGIN + "/infosec/synthetic")).rejects.toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
    await expect(transport.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
    expect(seen).toEqual([LOGIN_ORIGIN + "/infosec/synthetic", PORTAL_ORIGIN + "/sonline/synthetic/read"]);
  });

  /**
   * The other side of the same change, and the one that must never regress: signing in walks exactly
   * this shape while `beginLogin` has cleared the session, so no hop may be treated as protected.
   */
  test("the same shape before sign-in follows the redirect instead of clearing anything", async () => {
    const seen: string[] = [];
    const transport = new MaccabiTransport({ fetch: async input => {
      const href = String(input);
      seen.push(href);
      if (href === LOGIN_ORIGIN + "/infosec/synthetic") return new Response(null, { status: 302, headers: { location: PORTAL_ORIGIN + "/my.policy" } });
      if (href === PORTAL_ORIGIN + "/my.policy") return new Response(null, { status: 302, headers: { location: LOGIN_ORIGIN + "/login" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    } });
    const response = await transport.request(LOGIN_ORIGIN + "/infosec/synthetic");
    expect(response.status).toBe(200);
    expect(seen).toEqual([LOGIN_ORIGIN + "/infosec/synthetic", PORTAL_ORIGIN + "/my.policy", LOGIN_ORIGIN + "/login"]);
  });

  /** A portal-started chain is unchanged: the login-host clause still fires on the first hop. */
  test("an authenticated portal request redirected to the login host still clears the session", async () => {
    const transport = new MaccabiTransport({ fetch: async () => new Response(null, { status: 302, headers: { location: LOGIN_ORIGIN + "/login?SAMLRequest=synthetic" } }) });
    transport.markAuthenticated();
    await expect(transport.request(PORTAL_ORIGIN + "/sonline/synthetic/read")).rejects.toBeInstanceOf(ReauthenticationRequired);
    await expect(transport.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
  });

  /** Deliberate: a 403 on a live portal session is bot mitigation, not expiry, so the jar survives. */
  test("a 401 or 403 on an authenticated portal request fails that request without touching the session", async () => {
    for (const status of [401, 403]) {
      const transport = new MaccabiTransport({ fetch: async () => new Response(null, { status }) });
      transport.markAuthenticated();
      await expect(transport.request(PORTAL_ORIGIN + "/sonline/synthetic/read")).rejects.toMatchObject({ code: "HTTP_ERROR", status });
      expect((await transport.exportSession()).authenticatedAt).toBeTruthy();
    }
  });
});

describe("the imaging handoff exemption", () => {
  const handoff = "/sonline/TestResultsAPI/webapi/mac/pdf/members/0/1/meddream/token/1.2.3?checksum=SYNTHETIC";
  const authenticated = (location: string) => {
    const transport = new MaccabiTransport({ fetch: async () => new Response(null, { status: 302, headers: { location } }) });
    transport.markAuthenticated();
    return transport;
  };

  /** The one shape this flow needs: a portal request whose success looks exactly like expiry. */
  test("the handoff redirect to the imaging login is handed back instead of killing the session", async () => {
    const transport = authenticated(LOGIN_ORIGIN + "/imaging/login?token=synthetic");
    const response = await transport.request(handoff, { imagingHandoff: true, redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(LOGIN_ORIGIN + "/imaging/login?token=synthetic");
    expect((await transport.exportSession()).authenticatedAt).toBeTruthy();
  });

  /**
   * The half that matters more. The exemption is one exact destination, so every other shape the
   * expiry rule was written for still clears the jar - including on this very request, which is how
   * a genuinely expired session behaves when a member asks for a study.
   */
  test("every other redirect target still clears the session, even with the flag set", async () => {
    for (const location of [
      "/my.policy",
      LOGIN_ORIGIN + "/my.policy",
      LOGIN_ORIGIN + "/login?SAMLRequest=synthetic",
      // Normalises to /my.policy on the login host, so the path half of the check still sees it.
      LOGIN_ORIGIN + "/imaging/login/../../my.policy",
    ]) {
      const transport = authenticated(location);
      await expect(transport.request(handoff, { imagingHandoff: true, redirect: "manual" })).rejects.toBeInstanceOf(ReauthenticationRequired);
      await expect(transport.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
    }
  });

  test("without the flag the imaging destination is read as expiry exactly as before", async () => {
    const transport = authenticated(LOGIN_ORIGIN + "/imaging/login?token=synthetic");
    await expect(transport.request(handoff, { redirect: "manual" })).rejects.toBeInstanceOf(ReauthenticationRequired);
    await expect(transport.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
  });

  test("the viewer host is reachable and the allowlist is not otherwise widened", async () => {
    const seen: string[] = [];
    const transport = new MaccabiTransport({ fetch: async input => {
      seen.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    } });
    await transport.requestJson(VIEWER_ORIGIN + "/studies/1.2.3/structure?storageId=synthetic");
    expect(seen).toEqual([VIEWER_ORIGIN + "/studies/1.2.3/structure?storageId=synthetic"]);
    for (const origin of ["https://meddreamy.maccabi4u.co.il.evil.example", "https://softneta.example", "https://maccabi4u.co.il"]) {
      await expect(transport.request(origin + "/studies/1.2.3/structure")).rejects.toMatchObject({ code: "UNSUPPORTED_ORIGIN" });
    }
  });
});

describe("the transport enforces the deadline it advertises", () => {
  test("a fetch that ignores its abort signal is still bounded by timeoutMs", async () => {
    // The signal is handed to fetch and nothing obliges fetch to honour it. When one does not, this
    // request used to wait with no bound at all - and because every MCP tool call runs behind a
    // single-session mutex, one such wait blocked every later call on that server for ever.
    const transport = new MaccabiTransport({ timeoutMs: 50, fetch: () => new Promise<Response>(() => {}) });
    await expect(transport.request(`${PORTAL_ORIGIN}/sonline/stalled`)).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  test("a signal that aborted before the request starts is not turned into a hung fetch", async () => {
    let calls = 0;
    const transport = new MaccabiTransport({ timeoutMs: 50, fetch: () => { calls++; return new Promise<Response>(() => {}); } });
    await expect(transport.request(`${PORTAL_ORIGIN}/sonline/cancelled`, { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(calls).toBe(1); // The abort is observed around the call, not by declining to make it.
  });
});

describe("no failure path abandons a response body", () => {
  // Node's fetch keeps the socket assigned to an unconsumed body, so a throw that walks past one
  // pins a connection in the pool until the process exits. Measured before this was fixed: forty
  // failing requestJson calls against a local peer left forty live TCP connections and reused none
  // of them, and two hundred of them saturated the default 128-connection pool for good. The CLI
  // exits after one command, but the MCP server is long-lived and a portal outage produces exactly
  // these paths, so every one of them has to release the body it is throwing away.
  const cases: [string, ResponseInit, (transport: MaccabiTransport) => Promise<unknown>, boolean][] = [
    ["a non-ok JSON read", { status: 500, headers: { "content-type": "application/json" } }, transport => transport.requestJson(PORTAL_ORIGIN + "/sonline/x"), false],
    ["a JSON read answered with HTML", { status: 200, headers: { "content-type": "text/html" } }, transport => transport.requestJson(PORTAL_ORIGIN + "/sonline/x"), false],
    ["the 401/403 gate on an authenticated request", { status: 403 }, transport => transport.request(PORTAL_ORIGIN + "/sonline/x"), true],
    ["an expiry redirect to the login host", { status: 302, headers: { location: LOGIN_ORIGIN + "/my.policy" } }, transport => transport.request(PORTAL_ORIGIN + "/sonline/x"), true],
    ["a redirect off the allowlist", { status: 302, headers: { location: "https://evil.example/" } }, transport => transport.request(PORTAL_ORIGIN + "/sonline/x"), false],
    ["a redirect the caller asked to refuse", { status: 302, headers: { location: PORTAL_ORIGIN + "/sonline/y" } }, transport => transport.request(PORTAL_ORIGIN + "/sonline/x", { redirect: "error" }), false],
    ["an upstream cookie the jar rejects", { status: 200, headers: { "set-cookie": "a=b; Domain=example.org" } }, transport => transport.request(PORTAL_ORIGIN + "/sonline/x"), false],
    ["a Location header that is not a URL", { status: 302, headers: { location: "http://%" } }, transport => transport.request(PORTAL_ORIGIN + "/sonline/x"), false],
  ];
  for (const [name, init, call, authenticated] of cases) {
    test(`${name} releases its body`, async () => {
      let cancelled = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        start: controller => { controller.enqueue(new TextEncoder().encode("upstream body")); },
        cancel: () => { cancelled = true; },
      }), init);
      const transport = new MaccabiTransport({ fetch: async () => response });
      if (authenticated) transport.markAuthenticated();
      await expect(call(transport)).rejects.toBeInstanceOf(Error);
      expect(cancelled || response.bodyUsed).toBe(true);
    });
  }
});
