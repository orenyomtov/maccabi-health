/**
 * The only place a client-supplied URL becomes a `Location:` header, so it is the only thing
 * standing between this server and an open redirector. Two rules, nothing else, applied both at
 * registration and again at `/authorize` with the registered value in hand.
 */

/** Exact strings, never a prefix or suffix rule: a path prefix admits `/redirect/../../evil` and a host suffix admits `evil-vscode.dev`. */
export const HTTPS_REDIRECT_ALLOWLIST: readonly string[] = [
  "https://vscode.dev/redirect",
  "https://insiders.vscode.dev/redirect",
];

/**
 * `localhost` is here alongside the IP literals because real clients use it. Claude Code advertises
 * both `http://localhost/callback` and `http://127.0.0.1/callback` and listens on
 * `http://localhost:PORT/callback` in practice, so rejecting it — which RFC 8252 section 8.3 would
 * prefer, since the name resolves through DNS — breaks sign-in for the client this server exists to
 * serve. The rebinding concern it raises is answered elsewhere: nothing is fetched from this URL, it
 * is only handed to the member's browser, and the server's own Host header is validated separately.
 */
const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "[::1]", "localhost"];

function parse(uri: string): URL | null {
  try { return new URL(uri); } catch { return null; }
}
function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.includes(url.hostname) &&
    url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

/** Registration filter: every entry a client submits to `/register` must pass this or the whole registration is refused. */
export function isRegistrableRedirect(uri: string): boolean {
  if (HTTPS_REDIRECT_ALLOWLIST.includes(uri)) return true;
  const url = parse(uri);
  return url !== null && isLoopback(url);
}

/**
 * Authorization-time match. Loopback registrations vary only by port, because a native client binds
 * an ephemeral one after it registered (RFC 8252 section 7.3); everything else must be identical.
 * The https entries match by exact string, so a registered one cannot be widened after the fact.
 */
export function matchesRegistered(registered: string, presented: string): boolean {
  if (HTTPS_REDIRECT_ALLOWLIST.includes(registered)) return registered === presented;
  const a = parse(registered), b = parse(presented);
  if (!a || !b || !isLoopback(a) || !isLoopback(b)) return false;
  return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname;
}
