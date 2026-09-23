# Why the Maccabi session expires

This records what we actually verified about session lifetime, as opposed to what we assumed. It's here because the CLI/MCP "logs out constantly" complaint kept getting misdiagnosed, and because two of our own findings turned out to be wrong once we decoded the evidence properly instead of grepping it.

None of the numbers below include any actual cookie value, token, or ID. Where a length or structure matters it's given as a shape, not a value.

## Two independent clocks

There isn't one timeout. There are two, and they matter for different reasons.

### 1. Absolute cap — 3600 seconds from login

Enforced by F5 BIG-IP APM, not by anything downstream. The `F5_ST` cookie's value decodes as five `z`-separated all-numeric fields, with lengths `[1, 1, 1, 10, 4]`: three single-digit flags, a 10-digit epoch, and a 4-digit duration. The epoch equals the login time and never advances across the life of the session. The duration field was `3600` in every issuance we observed.

Evidence: six logins across 8.6 hours of captured traffic. In each one, `F5_ST` is set exactly once via `Set-Cookie` and then echoed back as a plain request cookie anywhere from 87 to 458 times — it is never re-issued. One session died at +3645s after having successfully pinged `/alive` at +2848s, +3055s, and +3330s. Activity does not postpone this clock.

Conclusion: nothing the client does extends this cap. We're confident about the behavior — a roughly 60-minute ceiling anchored to the login timestamp, indifferent to activity — but not about which specific F5 APM configuration knob the literal `3600` corresponds to. It doesn't matter for us; the effect is what we have to design around, not the setting's name.

**Confirmed live on this client's own API path, 2026-09-23.** The cap was predicted from `F5_ST` at login and the session died within 15 seconds of the prediction, an hour later, with twelve successful renewals in between. "Roughly 60 minutes" is now exactly 3600 seconds. See "The hour-long run that answered both probes" below.

### 2. Idle timeout — real, shorter, and the one that actually hurts us

This one lives entirely server-side. It appears in no cookie, so we can't read it off the wire the way we can the absolute cap. Every capture we have comes from a browser that was being actively used, so all we can establish is a floor, not the real ceiling.

Known floor: one session survived true request gaps of 392s, 362s, 360s, and 359s with no expiry. For context, F5's documented default inactivity timeout is 900s, and the portal's own JavaScript pops an idle warning at `idle_timeout_in_seconds = 360` (an older build used 420) and then logs the browser out client-side — that warning/logout is a separate, browser-side mechanism and tells us nothing about the server's actual idle clock.

**Decisive field evidence (2026-09-23):** a session was created at 12:19 local and was already being rejected at 12:45 — about 26 minutes in, nowhere near the ~60-minute absolute cap. Its cookie jar's `lastAccessed` was still exactly equal to the login timestamp, which proves nothing had touched the session in the interim. Three separate commands (`labs` twice, `status --verify`) all came back `AUTH_REQUIRED`, and each one made a real network round trip (420ms and 264ms, against a 109-145ms no-network baseline) rather than failing locally. This is an idle expiry, not the absolute cap.

This is why the CLI feels like it "logs out constantly": it's a new process per invocation, so a user running one command every twenty minutes or so never keeps the session warm, and falls into the idle window well before the absolute cap would ever be reached.

The idle clock is defeatable, and as of 2026-09-23 we have run the experiment — see the next section. Its exact threshold is still unmeasured, and no longer interesting.

## The hour-long run that answered both probes (2026-09-23)

Probes A and B at the bottom of this file were written as two separate experiments. One run answered both, because the question that actually matters is not "does keep-alive work" on its own but "with keep-alive running, which clock kills the session".

Setup: one login at 10:41:49Z, then `maccabi keep-alive --interval 240 --duration 3600` as the only steady traffic on the session. A watcher polled `session.json`'s mtime to see each renewal land, and probed the session at fixed times.

Twelve keep-alive ticks fired 240 seconds apart and all succeeded: 10:55:25, 10:59:15, 11:03:15, 11:07:15, 11:11:15, 11:15:16, 11:19:16, 11:23:16, 11:27:16, 11:31:17, 11:35:17, 11:39:17Z.

**Proof point at 11:38:24Z**, T+56m35s from login. `maccabi status --verify --json` exited 0 reporting `signed-in` with `verified: true`. That is a real network round trip, not a local read of the saved file.

**Predicted death at 11:41:40Z.** That figure was decoded from `F5_ST` at login time — five `z`-separated numeric fields, field[3] the login epoch and field[4] the 3600-second timeout — an hour before the event.

**Death confirmed by 11:41:55Z.** The post-cap probe exited 3 with `AUTH_REQUIRED`, and the CLI removed the stored session, which is its designed behaviour on `ReauthenticationRequired`. The prediction was right to within 15 seconds.

### Conclusion 1: keep-alive defeats the idle timeout

The decisive point is not that the session outlived the 26-minute idle death measured earlier the same day. It is *where* it died: at the absolute ceiling, not before it. Had the idle timer still been binding, the session would have ended somewhere earlier. Keep-alive is what carried it to the cap.

**Honest caveat, so nobody reads more into this than it supports.** Unrelated MCP traffic was running on the same session until 11:20:45Z. The proof point at 11:38:24Z therefore had 17m39s of keep-alive-only traffic behind it, not a clean window longer than the 26-minute idle death. The conclusion still holds — 17m39s is most of the way there, and more to the point the session died on the cap rather than anywhere before it — but this was not a perfectly isolated experiment, and a future run that wants one should hold all other traffic off the session for the full hour.

### Conclusion 2: the 3600-second cap is exact, and it is enforced on the API path

Everything we had before came from browser captures. The cap applies identically to this client's own requests. `expiresAt`, decoded locally with no request made, predicted the death an hour in advance and was off by under 15 seconds, so the number in the cookie is the real deadline and not an approximation to hedge around. Twelve successful renewals did not move it by a second. Nothing the client does extends it.

This also disposes of the alternative Probe B was written to catch: survival past the cap, which would have meant no absolute limit on this path at all. It did not happen.

### Conclusion 3: `keep-alive` handles the expiry correctly

The command exited at 11:43:22Z, on its first tick after the session died, printing `AUTH_REQUIRED` along with the recovery commands. It stops rather than spinning against a dead session, and it does not send an SMS on its own.

### What this means for anyone using the CLI

Keep-alive converts "the session dies whenever you stop using it" into "the session dies once an hour, on schedule". That is the whole of the improvement available, and it is a real one. The hourly re-login cannot be avoided: every login needs an SMS code, there is no password and no refresh token. See "Auto-reconnect is impossible" below.

## What an expiry actually looks like on the wire

Measured 2026-09-23 against a session that was already dead, with both of the client's expiry triggers disabled so the raw chain could be followed past the point where we normally throw.

Expiry has exactly one shape. A request to the portal origin comes back as a single-hop `302` whose `Location` is `https://online.maccabi4u.co.il/my.policy` — the portal origin itself, not the login origin. Empty body, no `content-type`, no `www-authenticate`. That is the entire signal. In `transport.ts` the `next.pathname === "/my.policy"` clause is what actually catches it; the `next.origin === LOGIN_ORIGIN` clause never fires on this shape, and both clauses stay as written.

**There is no 401 and no 403 anywhere in the chain** — not on the first hop, not on any hop after it. F5 BIG-IP APM enforces expiry at the edge with a redirect, so the application behind it never gets to answer at all. Whatever a bare 401 or 403 from the portal means, it does not mean "your session expired."

**F5 does not delete `MRHSession` on expiry — it rotates it.** The redirect carries `Set-Cookie` for `__uzmc`, `__uzmd`, `LastMRH_Session` and `MRHSession`, handing back a fresh anonymous session; `MRHSHint` is the only cookie actually deleted. So "do we still hold an `MRHSession`?" answers yes on a session that is stone dead, and `hasPortalSession()` is useless as an expiry signal. Don't build anything on it.

**The order inside the hop loop is what makes the fix work.** `packages/core/src/transport.ts:141-147` absorbs `Set-Cookie` before any trigger check runs, so by the time the redirect check fires, the jar already holds the anonymous replacement. That is why the `clearSession()` on the `/my.policy` trigger has to stay: without it the jar keeps the anonymous cookie and every later request loops straight back into `/my.policy`, with nothing in the resulting error naming the cause.

One hop further along, `/my.logout.php3` answers `200 text/html` with an F5 logon page a few kilobytes long. We never reach it in practice, because the redirect trigger catches the hop before it — but it is what would surface if F5 ever served that page directly instead of redirecting.

## Auto-reconnect is impossible

This is a well-evidenced negative, not just an absence of evidence for the alternative.

All 10 `otp/generateV2` + `otp/validate` pairs across the captures map 1:1 onto the 10 working logins. Every SAML ACS POST that actually established a session was preceded, within seconds, by the full chain: `infosec/auth -> otp/detailsV2 -> otp/generateV2 -> otp/validate -> infosec/response -> ACS`. A double-ACS pattern that superficially looked like a silent re-handshake turned out, every time, to have an SMS in between it. Separately, roughly ten `my.policy -> /login -> IdP /login` sequences just dead-end at the login page and never produce an ACS at all; one of those returned a 401.

`packages/core/src/auth.ts:88` posts `{ id, password: "", type: "none" }` — there is no password on the client side and no refresh token to replay. There is nothing to silently re-authenticate with.

**Operational consequence, stated plainly:** an automatic reconnect would mean an automatic SMS to the member's phone, one code-entry attempt made without them watching, and — on a wrong code — a locked Maccabi account. The current behavior ("No automatic SMS retry was made.") has to stay. Do not build auto-reconnect on top of this without solving that problem first.

## Hypotheses that were tested and disproven — do not revisit

- **"We persist the cookie jar at login and then discard every refreshed cookie."** False. `packages/core/src/transport.ts:141-147` captures cookies on every redirect hop — the capture sits inside the hop loop and runs before the redirect branch, so no hop is skipped. The jar is re-serialized after every successful command, at `packages/cli/src/cli.ts:373`, `packages/mcp/src/tools.ts:141`, and `cli.ts:410`.

- **"MRHSession rotates mid-session."** Half of this turned out to be true, but not the half we argued about, and the way we first checked it was worthless in both directions. Both original claims rested on raw `grep` over the `.mitm` archives, which store bodies compressed — a negative result there proves nothing, and so does a positive one for a value that looks like it changed. Decode with `mitmdump -n -q -s` and a `FlowReader`, or use the already-decoded structure dumps under `captures/proxy-login/analysis/`, and treat this as a general trap for this dataset rather than a note about one cookie. What a live trace does now show: `MRHSession` rotates *at expiry*, not mid-session — see "What an expiry actually looks like on the wire" above.

- **A 34-minute session death in `confirmation-maintenance-status.log`.** Looked like a short timeout at first glance, but turned out to be an explicit `GET /logout` 76 seconds earlier. What's still genuinely unexplained: that logout came from the browser and killed a CLI session that was running its own separate cookie jar. We don't have a mechanism for that. Worth digging into if it happens again — it may point at server-side session affinity by member rather than by cookie.

## What we shipped against this

Neither clock can be removed, so the code does the two things that are actually available.

- **The stdio MCP server renews on a 240-second timer** (`packages/mcp/src/stdio.ts`, `startSessionRenewal`). It is the only long-lived process in this project, so it is the one place an in-process timer works at all. It runs through the same `exclusive()` executor the tools use, saves refreshed cookies through the lease, stops after a failure instead of hammering a dead session, and never invalidates the stored credential from the timer path — a background task must not cost the member an SMS. HTTP deliberately has no equivalent: it is multi-user with per-member leases. The timer was observed firing against a live session for the first time on 2026-09-23, with a falsification step to rule out a concurrent `keep-alive` accounting for the writes — see [Live validation runs](LIVE-VALIDATION.md).

- **The CLI's own `keep-alive` is now findable.** It always existed; nobody knew about it. Its help text, `status`'s help text and `docs/CLI.md` now say plainly that it defeats the idle timeout and cannot touch the absolute cap. Both halves of that claim were measured on 2026-09-23 and are true.

- **`maccabi status` reports `expiresAt`**, decoded locally from `F5_ST` (`1z1z1z<start>z<timeout>`, both seconds) with no request. It is the absolute cap only; a malformed or absent cookie omits the field rather than guessing. On 2026-09-23 it predicted the death of a live session an hour ahead, to within 15 seconds.

Auto-reconnect stays out. Every login costs an SMS and allows one code attempt, and a wrong code locks the account.

## Two places our own code destroyed a possibly-live session — both now fixed

Both were flagged as suspected over-firing: proven as code paths, unproven as to how often they fired on a session that was actually fine. The 2026-09-23 traces settled the first one outright, and both are fixed.

- **A bare 401 or 403 no longer destroys anything** (`packages/core/src/transport.ts:148-152`). The old code treated any 401 or 403 from the portal origin as terminal: `clearSession()` emptied the jar so there was nothing left to salvage, `ReauthenticationRequired` propagated, `cli.ts` deleted the stored session file and `tools.ts` invalidated the lease — which over HTTP also revokes the member's OAuth grant. Since expiry never produces a 401 or 403 at all, that trigger could only ever have fired on something else, and the likeliest something else is Imperva: the live jar carries `__uzma/__uzmb/__uzmc/__uzmd`, and Imperva serves bot-mitigation challenges as 403. One challenged request cost the member an SMS login. It now throws `UpstreamError("HTTP_ERROR", status)` instead: the one request fails, the jar is untouched, and a session that really is dead still dies on the redirect check a few lines below.

- **A dependent selected in the portal no longer costs a login** (`packages/core/src/readers/index.ts`). `logged_customer_info !== current_customer_info` is exactly what a live, perfectly working session looks like while a dependent is selected — the logged-in member and the currently-viewed one differ on purpose. That case now raises its own code, `DEPENDENT_SELECTED`, whose guidance says the session is fine, no new login is needed, and the fix is to switch the portal back to the logged-in member. `OWNER_MISMATCH` is kept for what it was always meant to be: the saved owner not matching the logged-in one. The deletion conditions at `packages/cli/src/cli.ts:377` and `packages/mcp/src/tools.ts:147` now key on `ReauthenticationRequired` alone, so neither code removes the session file or invalidates the lease.

Alongside those, a latent gap was closed rather than left to be discovered later. `json()` in `packages/core/src/readers/index.ts` had no content-type check, so the F5 logon page described above would have surfaced as `INVALID_RESPONSE` — whose guidance wrongly tells the caller this is a gap in the client, not to retry, and to treat the read as unsupported. It now recognises an HTML response carrying an F5 marker and raises `ReauthenticationRequired`; any other HTML is still reported as a parsing gap, which is a genuinely different answer for the caller. This branch is unreachable while the `/my.policy` trigger catches the hop before it, and it is there for the case where F5 serves the page without the redirect.

## The probes, and what became of them

All three are now closed. Kept here as written so the reasoning that produced them stays visible; the answers are above. Costs were in SMS messages, since every login costs one.

- **Probe A — idle timeout.** *Closed 2026-09-23 as designed, answered a different way.* The original plan was a fresh login and `status --verify` after deliberate gaps of 12, 14 and 16 minutes, to bracket where the idle threshold sits. That was never run, and the run that happened instead answers the question that mattered: with keep-alive holding the session, it lived to the absolute cap rather than dying in the idle window. **Still unmeasured:** the exact idle threshold, somewhere between the 392-second gap a browser session is known to survive and the 26-minute death measured on 2026-09-23. That number no longer changes anything we do — keep-alive at 240 seconds sits well under the known floor — so it is not worth an SMS.

- **Probe B — absolute cap on the API path.** *Answered 2026-09-23, run essentially as written.* A fresh login and `maccabi keep-alive --interval 240 --duration 3600`. Death landed within 15 seconds of the `F5_ST`-derived prediction. Keep-alive defeats the idle timeout and does not touch the cap, exactly as the probe was framed to test. The alternative it was written to catch — survival past the cap, meaning no absolute limit on this path — did not occur.

- **Probe C — self-inflicted destruction.** Answered without running it. Selecting a dependent no longer produces `AUTH_REQUIRED` and no longer removes the session file; it returns `DEPENDENT_SELECTED` and leaves the session alone, pinned by tests on the core, CLI and MCP sides. Nothing left to probe here.

### Still open

- **The cross-jar logout** noted under disproven hypotheses: a browser `GET /logout` that killed a CLI session running its own separate cookie jar. No mechanism for it, and no attempt to reproduce it. If it recurs, it points at server-side session affinity by member rather than by cookie.

- **Whether the 3600-second figure ever differs.** It was `3600` in every `F5_ST` issuance across six captured logins and in the 2026-09-23 run. The client reads the field rather than hardcoding the number, so a change would be handled, but nothing here establishes that Maccabi never varies it.
