import { Cookie, CookieJar, type SerializedCookieJar } from "tough-cookie";
import { name, version, bugs } from "../../../package.json";
import { MaccabiError, ReauthenticationRequired, UpstreamError } from "./errors";
import type { MaccabiSession } from "./session";

/**
 * How this client identifies itself: our name, our version and where to complain about us. Node's
 * fetch sends no User-Agent at all, which is worth fixing on its own - an operator who wants to
 * rate-limit or block this client should be able to do it on sight.
 *
 * It is deliberately not a browser string. The public directory host is behind a bot filter that
 * scores each request, and an honest UA does not get past it: it let one call through and then
 * failed the next three identical ones. Only a full browser impersonation moved the needle, which
 * is not something this client does. See docs/CAPABILITIES.md.
 */
export const USER_AGENT = `${name}/${version} (+${bugs.url})`;

export const LOGIN_ORIGIN = "https://mac.maccabi4u.co.il";
export const PORTAL_ORIGIN = "https://online.maccabi4u.co.il";
/**
 * The MedDream imaging viewer. Its own host, its own F5 APM session and its own application session,
 * none of which share anything with the portal beyond the one handoff that mints them. Listed here
 * because the imaging chain walks onto it; nothing else in this client requests it.
 */
export const VIEWER_ORIGIN = "https://meddreamy.maccabi4u.co.il";
const allowedOrigins = new Set([LOGIN_ORIGIN, PORTAL_ORIGIN, VIEWER_ORIGIN]);
/** The single portal redirect whose LOGIN_ORIGIN target means success rather than an expired session. */
export const IMAGING_HANDOFF_PATH = "/imaging/login";
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export type FetchFunction = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;
export interface TransportRequestInit extends RequestInit {
  /** Direct browser document downloads were observed using cookies without a bearer. */
  apiAuthorization?: boolean;
  /**
   * Set only on the imaging handoff request, which is the one authenticated portal call whose success
   * is a 302 to LOGIN_ORIGIN - byte-for-byte the shape this transport otherwise reads as F5 expiry.
   * The exemption is one exact destination, LOGIN_ORIGIN + IMAGING_HANDOFF_PATH, and nothing else: a
   * redirect to /my.policy, or anywhere else on the login host, still clears the jar as before.
   */
  imagingHandoff?: boolean;
}

export interface TransportOptions {
  fetch?: FetchFunction;
  session?: MaccabiSession;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * A fetch is handed the abort signal, but nothing obliges an implementation to settle when it fires,
 * and one that does not turns this transport's timeout into an unbounded wait. Node's own fetch has
 * stalls it cannot cancel - a name lookup already running in the libuv threadpool is not
 * interruptible - so the timeout is enforced here as well as delegated. The abandoned request is left
 * to finish or fail on its own; what matters is that this promise settles, because everything above
 * it runs behind a single-session mutex where one unbounded wait blocks every later call.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => { signal.removeEventListener("abort", abort); });
  });
}

/**
 * Release a response nobody is going to read. Node's fetch keeps the socket assigned to an
 * unconsumed body, so a throw that walks past one pins a connection in the pool for the rest of the
 * process - which matters most in the long-lived MCP server, where a run of failing reads is exactly
 * the shape that saturates it. An already-consumed or errored body is not a failure to report.
 */
export async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* nothing left to release */ }
}

/**
 * Read a body with a ceiling that is actually a ceiling. `arrayBuffer()` and `text()` buffer the
 * whole response before anyone can look at its length, so a size check written after one of those
 * is an integrity check on bytes already resident - an upstream that ignores its own content-length
 * can still push a process into swap. This reads chunk by chunk and cancels the stream at the first
 * one that crosses `maxBytes`, so the peak is the cap plus one chunk rather than whatever was sent.
 *
 * `failure` is thrown for an oversized body, so a caller that used to check the length afterwards
 * raises exactly what it raised before. A null body reads as empty, which is what `arrayBuffer()`
 * gives for one.
 */
export async function readCappedBody(response: Response, maxBytes: number, failure: Error): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  return readResponseBody(async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw failure; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }, failure);
}

/** Keep aborted native fetch body reads distinct from malformed upstream content. */
export async function readResponseBody<T>(consume: () => Promise<T>, failure: Error): Promise<T> {
  try { return await consume(); }
  catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new UpstreamError("REQUEST_TIMEOUT");
    if (error instanceof Error && error.name === "AbortError") throw new UpstreamError("REQUEST_ABORTED");
    throw failure;
  }
}

/** Cookie-aware HTTPS transport shared by login and account readers. */
export class MaccabiTransport {
  readonly #fetch: FetchFunction;
  #jar: CookieJar;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #authenticatedAt?: string;
  #apiAuthorization?: string;

  constructor(options: TransportOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    // The saved file is {session, owner}; handing that whole object to `session` is the common
    // mistake, and a bare INVALID_SESSION does not say which part to pass.
    if (options.session && !("version" in options.session) && (options.session as { session?: unknown }).session)
      throw new MaccabiError("SESSION_NOT_UNWRAPPED", "Pass the inner `session` value, not the whole saved file: session.json holds {session, owner} and this option takes its `session` property.");
    if (options.session && options.session.version !== 1) throw new UpstreamError("INVALID_SESSION");
    try {
      this.#jar = options.session ? CookieJar.deserializeSync(options.session.cookies) : new CookieJar();
    } catch {
      throw new UpstreamError("INVALID_SESSION");
    }
    this.#authenticatedAt = options.session?.authenticatedAt;
    this.#apiAuthorization = options.session?.apiAuthorization;
  }

  setApiToken(token: string): void {
    if (!token || /[\r\n]/.test(token)) throw new UpstreamError("INVALID_API_TOKEN");
    this.#apiAuthorization = `Bearer ${token}`;
  }

  /** Called only after the observed ACS and portal-homepage success chain. */
  markAuthenticated(): void {
    this.#authenticatedAt = new Date(this.#now()).toISOString();
  }

  async exportSession(): Promise<MaccabiSession> {
    if (!this.#authenticatedAt) throw new ReauthenticationRequired();
    return {
      version: 1,
      cookies: await this.#exportPortalCookies(),
      authenticatedAt: this.#authenticatedAt,
      ...(this.#apiAuthorization ? { apiAuthorization: this.#apiAuthorization } : {}),
    };
  }

  /**
   * The viewer handoff mints its own F5 and MedDream cookies on VIEWER_ORIGIN. Persisting them is
   * not merely redundant: on the next run the viewer's F5 session is still live, the SAML leg does
   * not replay the way the handoff parser expects, and the token mint comes back unsuccessful, so
   * every imaging read after the first fails TOKEN_UNAVAILABLE. Measured live 2026-09-23: dropping
   * them restores 4/4 consecutive successes. The chain re-runs per read, so nothing needs them.
   */
  async #exportPortalCookies(): Promise<SerializedCookieJar> {
    const serialized = await this.#jar.serialize();
    const viewerHost = new URL(VIEWER_ORIGIN).hostname;
    return { ...serialized, cookies: serialized.cookies.filter(cookie => cookie.domain !== viewerHost) };
  }

  /** Drop any viewer cookies before a handoff so a jar saved by an older build still replays cleanly. */
  async clearViewerCookies(): Promise<void> {
    const viewerHost = new URL(VIEWER_ORIGIN).hostname;
    for (const cookie of await this.#jar.getCookies(VIEWER_ORIGIN + "/")) {
      if (cookie.domain === viewerHost && cookie.key) await this.#jar.store.removeCookie(viewerHost, cookie.path ?? "/", cookie.key);
    }
  }

  /** Mid-login cookies for a challenge another process finishes; exportSession refuses before sign-in completes. */
  async exportCookies(): Promise<SerializedCookieJar> {
    return this.#jar.serialize();
  }

  importCookies(cookies: SerializedCookieJar): void {
    try { this.#jar = CookieJar.deserializeSync(cookies); }
    catch { throw new UpstreamError("INVALID_SESSION"); }
  }

  async clearSession(): Promise<void> {
    await this.#jar.removeAllCookies();
    this.#authenticatedAt = undefined;
    this.#apiAuthorization = undefined;
  }

  async hasPortalSession(): Promise<boolean> {
    return (await this.#jar.getCookies(PORTAL_ORIGIN + "/"))
      .some(cookie => cookie.key === "MRHSession" && Boolean(cookie.value));
  }

  /** Observed portal bootstrap keeps the first owner-named navigation session until its cookie is absent. */
  async getOrCreatePortalNavigationSession(owner: { memberId: number; memberIdCode: string }, bootstrapSessionId: string): Promise<string> {
    if (!Number.isSafeInteger(owner.memberId) || owner.memberId < 0 || typeof owner.memberIdCode !== "string" || !/^\d+$/.test(owner.memberIdCode)) throw new UpstreamError("INVALID_NAVIGATION_SESSION");
    const key = `cookie_sessionId_${owner.memberIdCode}_${owner.memberId}`;
    try {
      const existing = (await this.#jar.getCookies(PORTAL_ORIGIN + "/")).find(cookie => cookie.key === key);
      if (existing?.value) {
        if (!existing.validate()) throw new UpstreamError("INVALID_NAVIGATION_SESSION");
        return existing.value;
      }
      const cookie = new Cookie({ key, value: bootstrapSessionId, path: "/", secure: true });
      if (!cookie.validate()) throw new UpstreamError("INVALID_NAVIGATION_SESSION");
      await this.#jar.setCookie(cookie, PORTAL_ORIGIN + "/");
      return cookie.value;
    } catch {
      throw new UpstreamError("INVALID_NAVIGATION_SESSION");
    }
  }

  async request(input: string | URL, init: TransportRequestInit = {}): Promise<Response> {
    let url = this.#checkedUrl(input);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    const headers = new Headers(init.headers);
    // Cookies always come from their scoped jar, never an unscoped caller header.
    headers.delete("cookie");
    if (init.apiAuthorization !== false && url.origin === PORTAL_ORIGIN && url.pathname.startsWith("/sonline/") && !headers.has("authorization")) {
      // The observed portal interceptor emits this literal when sessionStorage is empty.
      headers.set("authorization", this.#apiAuthorization ?? "Bearer null");
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    for (let hop = 0; hop <= 8; hop++) {
      // Judged per hop, against the request as it actually is: only a hop that carries this jar's
      // authenticated portal cookies says anything about that session. A chain that starts on the
      // portal is unaffected — it can never walk on to LOGIN_ORIGIN, because the expiry check below
      // fires on the hop before. A chain that starts on LOGIN_ORIGIN and is redirected onto the
      // portal becomes protected from that hop on, which the initial-URL reading missed. Sign-in
      // itself is never protected: `beginLogin` clears the session first, so `#authenticatedAt` is
      // unset for every request the login flow makes.
      const protectedRequest = Boolean(this.#authenticatedAt) && url.origin === PORTAL_ORIGIN;
      const outbound = new Headers(headers);
      const cookies = await this.#jar.getCookieString(url.href);
      if (cookies) outbound.set("cookie", cookies);
      let response: Response;
      try {
        const { apiAuthorization: _apiAuthorization, imagingHandoff: _imagingHandoff, ...fetchInit } = init;
        response = await abortable(this.#fetch(url.href, { ...fetchInit, method, body, headers: outbound, redirect: "manual", signal }), signal);
      } catch {
        throw new UpstreamError(timeout.aborted && signal.reason === timeout.reason ? "REQUEST_TIMEOUT" : signal.aborted ? "REQUEST_ABORTED" : "NETWORK_ERROR");
      }
      try {
        for (const cookie of response.headers.getSetCookie()) {
          await this.#jar.setCookie(cookie, url.href);
        }
      } catch {
        await discard(response);
        throw new UpstreamError("INVALID_UPSTREAM_COOKIE");
      }
      // Measured on live traffic: F5 enforces expiry with a 302 to /my.policy and never a bare 401 or
      // 403, while this jar's Imperva cookies make a 403 here most likely a bot-mitigation challenge.
      // Failing the one request without touching the jar keeps a still-live session usable; a session
      // that really is dead still dies on the redirect check below.
      if (protectedRequest && [401, 403].includes(response.status)) { await discard(response); throw new UpstreamError("HTTP_ERROR", response.status); }
      const location = response.headers.get("location");
      if (!redirectStatuses.has(response.status) || !location) return response;
      let next: URL;
      try { next = this.#parsedUrl(location, url); }
      catch (error) { await discard(response); throw error; }
      // One destination, opted into per request by the one caller that asked for the handoff. An
      // expired session answers that same request with /my.policy instead, which is not this path,
      // so everything the expiry rule caught before it is still caught.
      const handoff = init.imagingHandoff === true && next.origin === LOGIN_ORIGIN && next.pathname === IMAGING_HANDOFF_PATH;
      // The only observed expiry shape. F5 rotates MRHSession rather than deleting it, and the loop
      // above has already stored that fresh anonymous one, so clearing the jar here is what stops
      // every later request from looping back into /my.policy with nothing naming the cause.
      if (protectedRequest && !handoff && (next.origin === LOGIN_ORIGIN || next.pathname === "/my.policy")) {
        await discard(response);
        await this.clearSession();
        throw new ReauthenticationRequired(response.status);
      }
      // A manual-redirect caller follows the hop itself, so the response is handed back before the
      // allowlist gets a say; the allowlist only governs destinations this transport requests itself.
      if (init.redirect === "manual") return response;
      try { this.#assertAllowedOrigin(next); }
      catch (error) { await discard(response); throw error; }
      if (init.redirect === "error") { await discard(response); throw new UpstreamError("UNEXPECTED_REDIRECT", response.status); }
      if (next.origin !== url.origin) {
        headers.delete("authorization");
        headers.delete("origin");
        headers.delete("referer");
      }
      if (response.status === 303 && method !== "HEAD" || [301, 302].includes(response.status) && method === "POST") {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      await discard(response);
      url = next;
    }
    throw new UpstreamError("TOO_MANY_REDIRECTS");
  }

  async requestJson<T = unknown>(input: string | URL, init: TransportRequestInit = {}): Promise<T> {
    const response = await this.request(input, init);
    if (!response.ok) { await discard(response); throw new UpstreamError("HTTP_ERROR", response.status); }
    if (!response.headers.get("content-type")?.toLowerCase().includes("json")) { await discard(response); throw new UpstreamError("EXPECTED_JSON", response.status); }
    return readResponseBody(() => response.json() as Promise<T>, new UpstreamError("INVALID_JSON", response.status));
  }

  #parsedUrl(input: string | URL, base: string | URL = PORTAL_ORIGIN): URL {
    try { return new URL(input, base); }
    catch { throw new UpstreamError("INVALID_URL"); }
  }

  /** The only origins this transport ever requests on its own. */
  #assertAllowedOrigin(url: URL): void {
    if (!allowedOrigins.has(url.origin) || url.username || url.password) throw new UpstreamError("UNSUPPORTED_ORIGIN");
  }

  #checkedUrl(input: string | URL): URL {
    const url = this.#parsedUrl(input);
    this.#assertAllowedOrigin(url);
    return url;
  }
}
