# Why the Maccabi session expires

What was verified about session lifetime. The CLI and MCP "logs out constantly" complaint is usually the idle clock, not a bug in this client.

None of the numbers below include any cookie value, token, or ID.

## Two independent clocks

### 1. Absolute cap — 3600 seconds from login

Enforced at the edge, not by anything downstream. The `F5_ST` cookie's value decodes as five `z`-separated all-numeric fields, with lengths `[1, 1, 1, 10, 4]`: three single-digit flags, a 10-digit epoch, and a 4-digit duration. The epoch equals the login time and never advances across the life of the session. The duration field was `3600` in every issuance observed.

Activity does not postpone this clock. Nothing the client does extends it.

**Confirmed live on this client's own API path, 2026-09-23.** The cap was predicted from `F5_ST` at login and the session died within 15 seconds of the prediction, an hour later, with twelve successful renewals in between. See the keep-alive run below.

### 2. Idle timeout — shorter, and the one that hurts day-to-day use

This one lives entirely server-side. It appears in no cookie, so it cannot be read off the wire the way the absolute cap can.

Known floor: one session survived true request gaps of 392s, 362s, 360s, and 359s with no expiry. The portal's own JavaScript pops an idle warning at `idle_timeout_in_seconds = 360` (an older build used 420) and then logs the browser out client-side — that warning is a separate, browser-side mechanism and tells nothing about the server's actual idle clock.

**Field evidence (2026-09-23):** a session created at T+0 was already rejected at about T+26m, nowhere near the absolute cap. Its cookie jar's `lastAccessed` was still exactly equal to the login timestamp, which proves nothing had touched the session in the interim. Three separate commands (`labs` twice, `status --verify`) all came back `AUTH_REQUIRED` after a real network round trip. This is an idle expiry, not the absolute cap.

This is why the CLI feels like it "logs out constantly": it is a new process per invocation, so a user running one command every twenty minutes or so never keeps the session warm, and falls into the idle window well before the absolute cap.

The idle clock is defeatable with `keep-alive`. Its exact threshold is still unmeasured, and no longer interesting for how this client is used.

## Keep-alive run (2026-09-23)

One login at T+0, then `maccabi keep-alive --interval 240 --duration 3600` as the only steady traffic on the session.

Twelve keep-alive ticks fired 240 seconds apart and all succeeded, spanning roughly T+14m through T+58m.

**Proof point at T+56m35s.** `maccabi status --verify --json` exited 0 reporting `signed-in` with `verified: true`. That is a real network round trip, not a local read of the saved file.

**Predicted death at T+3600s**, decoded from `F5_ST` at login time (field[3] the login epoch, field[4] the 3600-second timeout).

**Death confirmed by about T+3600s + 15s.** The post-cap probe exited 3 with `AUTH_REQUIRED`, and the CLI removed the stored session. The prediction was right to within 15 seconds.

### What that shows

1. **Keep-alive defeats the idle timeout.** The session died at the absolute ceiling, not before it.
2. **The 3600-second cap is exact on the API path.** Twelve successful renewals did not move it by a second. `expiresAt`, decoded locally with no request made, predicted the death an hour in advance.
3. **`keep-alive` handles expiry correctly.** It exited on its first tick after the session died, printing `AUTH_REQUIRED` along with the recovery commands. It stops rather than spinning against a dead session, and it does not send an SMS on its own.

Keep-alive converts "the session dies whenever you stop using it" into "the session dies once an hour, on schedule". That is the whole of the improvement available. The hourly re-login cannot be avoided: every login needs an SMS code, there is no password and no refresh token.

## What an expiry looks like on the wire

Measured 2026-09-23 against a session that was already dead, with the client's expiry triggers disabled so the raw chain could be followed.

Expiry has one observed shape. A request to the portal origin comes back as a single-hop `302` whose `Location` is `https://online.maccabi4u.co.il/my.policy` — the portal origin itself, not the login origin. Empty body, no `content-type`, no `www-authenticate`. In `MaccabiTransport` the `next.pathname === "/my.policy"` clause is what catches it; the `next.origin === LOGIN_ORIGIN` clause does not fire on this shape.

There is no 401 and no 403 anywhere in that chain. Whatever a bare 401 or 403 from the portal means, it does not mean "your session expired."

Cookie absorption on every redirect hop runs before the redirect trigger check, so by the time `/my.policy` fires the jar may already hold a replacement. That is why `clearSession()` on that trigger has to stay: without it later requests loop straight back into `/my.policy`.

## Auto-reconnect is impossible

Every working login observed maps 1:1 onto a full `infosec/auth → otp/detailsV2 → otp/generateV2 → otp/validate → infosec/response → ACS` chain. There is no password on the client side and no refresh token to replay (`MaccabiAuth` posts `{ id, password: "", type: "none" }`). There is nothing to silently re-authenticate with.

An automatic reconnect would mean an automatic SMS to the member's phone, one code-entry attempt made without them watching, and — on a wrong code — a locked Maccabi account. The current behavior ("No automatic SMS retry was made.") has to stay.

## What shipped against this

- **The stdio MCP server renews on a 240-second timer** (`startSessionRenewal` in `packages/mcp/src/stdio.ts`). It is the only long-lived process in this project. It runs through the same `exclusive()` executor the tools use, saves refreshed cookies through the lease, stops after a failure, and never invalidates the stored credential from the timer path. HTTP deliberately has no equivalent: it is multi-user with per-member leases. Observed live on 2026-09-23; see [Live validation runs](LIVE-VALIDATION.md).
- **CLI `keep-alive`** defeats the idle timeout and cannot touch the absolute cap. Both halves were measured on 2026-09-23.
- **`maccabi status` reports `expiresAt`**, decoded locally from `F5_ST` (`1z1z1z<start>z<timeout>`, both seconds) with no request. It is the absolute cap only; a malformed or absent cookie omits the field rather than guessing.

Auto-reconnect stays out.

## Related fixes already in the code

- A bare 401 or 403 from the portal no longer destroys the session (`MaccabiTransport`). It throws `UpstreamError("HTTP_ERROR", status)` instead: the one request fails, the jar is untouched, and a session that really is dead still dies on the `/my.policy` redirect check.
- A dependent selected in the portal no longer costs a login (`packages/core/src/readers/index.ts`). That case raises `DEPENDENT_SELECTED`; session deletion on the CLI and MCP sides keys on `ReauthenticationRequired` alone.
- `json()` in the readers recognises an HTML F5 logon page and raises `ReauthenticationRequired` rather than reporting a parsing gap. That branch is unreachable while the `/my.policy` trigger catches the hop first, and is there for the case where the page is served without the redirect.

## Still open

- Whether a browser logout can kill a CLI session that holds its own separate cookie jar. No mechanism established, and no attempt to reproduce it.
- Whether the 3600-second figure ever differs. It was `3600` in every issuance observed. The client reads the field rather than hardcoding the number.
