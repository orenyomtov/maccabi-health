# Authentication

How signing in works, what leaves your machine, and what is written to disk. Applies to both the CLI and the MCP server — they run the same code (`packages/cli/src/login.ts`), so there is one flow, not two.

## The upstream flow

Maccabi's web login is a SAML handoff between two origins: `mac.maccabi4u.co.il` issues the tokens, `online.maccabi4u.co.il` holds the portal session. A sign-in walks that handoff:

1. Scrape an `originJWT` from the login page.
2. `POST /infosec/auth` with the ID number → a sender JWT.
3. `POST /otp/detailsV2` → the list of phone numbers that can receive an SMS, each partly masked.
4. `POST /otp/generateV2` → Maccabi sends one six-digit code to the chosen number, and returns a validator JWT.
5. `POST /otp/validate` with the code → the validated assertion.
6. `POST /response` → a SAML assertion.
7. `POST /saml/sp/profile/post/acs` on the portal origin → portal session cookies.

Step 7 needs the cookie jar built up during steps 1-6. That single fact drives the whole design below.

## Why there is a pending-login file

`MaccabiAuth` keeps the challenge — the sender JWT, the validator JWT, and the cookie jar — in memory. That is fine for an interactive login, where one process prompts for the ID, waits, prompts for the code, and finishes. It does not survive `maccabi login --id` exiting and `maccabi login --code` starting as a new process minutes later.

So a two-step login exports the challenge to `pending-login.json` between the two commands, and restores it before the final SAML POST. The file exists only for the gap between steps 4 and 5.

HTTP mode does not use this file. That process stays up across all three steps, so each in-flight challenge lives in memory, scoped to the one authorization it belongs to, and is dropped when that authorization finishes or its ten minutes run out. It also fixes something a shared file cannot: two members signing in at the same moment would overwrite each other's challenge, and the loser's code would then be rejected — which is exactly what locks a Maccabi account.

## What is stored, where

Every file below lives in the config directory, resolved in this order:

1. `MACCABI_CONFIG_DIR` if set
2. `$XDG_CONFIG_HOME/maccabi-mcp`
3. `%APPDATA%\maccabi-mcp` on Windows
4. `~/.config/maccabi-mcp`

The directory is created mode `0700`. Every file is written mode `0600`, created at that mode rather than chmod'ed afterwards, and swapped in with `rename` — so no truncated or world-readable version is ever observable, even if the process dies mid-write. On load, a file whose mode has any group or other bits set prints a warning to stderr.

The temporary file each write swaps in is named with a fresh UUID, so concurrent writes never share a path. They used to be named after the process ID, which meant two writes in one process collided on the exclusive create and the loser's cleanup deleted the winner's file before it could be renamed — three overlapping writes could leave no session file at all. A failed write now only ever unlinks the temporary file it created itself; it never touches the real file, so a previously saved session survives intact.

Storage failures raise `SessionStoreError`, a `MaccabiError` with the code `SESSION_STORE_UNAVAILABLE`. The CLI maps it to exit code 1, and the MCP server returns that code rather than the generic `READ_UNAVAILABLE`, so a broken config directory is never reported as upstream flakiness. The message can name a file path, so only the CLI — running in the member's own terminal — prints it; MCP results carry fixed guidance instead.

### `session.json` — the signed-in session

```
{ session: { version, cookies: SerializedCookieJar, authenticatedAt, apiAuthorization? },
  owner:   { memberId, memberIdCode } }
```

Portal cookies and, when present, an API bearer token. Anyone who can read this file can read the member's medical records until Maccabi expires the session. It is rewritten after reads that refresh cookies, so its mtime tracks use.

### `pending-login.json` — the half-finished challenge

```
{ version, id, memberId, senderJwt, validatorJwt?, phones, expiresAt, cookies }
```

Live bearer tokens for an in-flight challenge. Ten-minute TTL, enforced when the file is read, not by a timer — an expired file is deleted and reported as if it were absent. Deleted on successful verify, on any failed verify, on `logout`, and on expiry. `validatorJwt` is present only once an SMS has actually been sent, which is how `--status` can distinguish "picked a phone, code sent" from "waiting for a phone choice".

### `oauth.json` — registered clients and live tokens

```
{ version, clients, codes, access, refresh }
```

Written only by `maccabi mcp --http`. Holds the clients registered through `/register` (at most 64, forgotten after 90 days idle), unredeemed authorization codes, and live access and refresh tokens. Every token is stored as its SHA-256 hash, so the file cannot be read back for a usable bearer token. It does carry each token's subject, and the matching `sessions/<subject>.json` beside it is the real secret. Removed by `maccabi logout --all`.

### `sessions/<subject>.json` — one signed-in member, HTTP mode

The same shape and the same rules as `session.json`, one file per member who has authorized through the browser. The name is the subject hash described under [MCP](#mcp), not the ID number. Removed when that member's read hits reauthentication, when they call `maccabi_logout`, and by `maccabi logout --all`.

### What is never stored

The ID number and the SMS code. Neither is written to either file as a credential, neither is logged, and neither appears in any error message or JSON field — error strings are self-authored, never upstream text echoed back. `memberId` in both files is the account identifier returned by Maccabi, used to detect a session belonging to a different member; it is not the login secret.

## CLI

```
maccabi login                           interactive, masked prompts
maccabi login --id DIGITS [--phone N]   start; sends one SMS
maccabi login --code DIGITS             finish
maccabi login --status                  offline, no network
maccabi logout                          deletes session.json and pending-login.json
maccabi logout --all                    also deletes oauth.json and every sessions/ file
```

`MACCABI_ID` and `MACCABI_OTP` are read only when the matching flag is absent; flags win. Passing `--id` and `--code` together is a usage error — they are two separate commands by design, because the SMS has to arrive in between.

When the account has more than one SMS-capable number and `--phone` was not given, `--id` prints the options and exits 3 **without sending anything**. Choosing on the member's behalf would send the code to a phone they may not be holding. This is the only exit-3 path that writes to stdout.

Both `--id` and `--code` land in argv. Other users on the machine can see them in `ps`, and the shell records them in history. The interactive prompts do not have this problem. That is the tradeoff for headless login; pick the interactive path when a terminal is available.

## MCP

Which sign-in tools exist depends on the transport, because the two transports give the member different ways to prove who they are.

| tool | arguments | stdio | loopback HTTP |
|---|---|---|---|
| `maccabi_login_start` | `{ id, phone? }` | yes | no |
| `maccabi_login_verify` | `{ code }` | yes | no |
| `maccabi_login_status` | `{}` | yes | yes |
| `maccabi_logout` | `{}` | yes | yes |

All are `.strict()`, and all are `readOnlyHint: false` because they mutate local state. They do not go through `withOwner`, the wrapper every read tool uses, because that wrapper requires an existing session — which is exactly what is missing. They do share the same `exclusive()` serializer, so a login cannot interleave with a read.

Over stdio, `maccabi_login_start` and `maccabi_login_verify` put the ID number and the SMS code into the model's context, and into whatever the client persists or sends upstream. The server's `instructions` string says so, and says to prefer `maccabi login` in the member's own terminal when that is possible. When a read fails with `REAUTHENTICATION_REQUIRED`, the guidance names both options and states that cost.

Over HTTP those two tools are not registered at all. The sign-in happens in the member's own browser, during authorization, so there is nothing for the model to carry. `maccabi_login_status` and `maccabi_logout` stay: they read and clear local state for the member the token belongs to.

### The browser sign-in

`maccabi mcp --http` is the authorization server and the resource server at once, on one loopback port:

| path | what it is |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata for `/mcp` |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `/register` | RFC 7591 dynamic client registration |
| `/authorize` | the browser sign-in: GET renders a form, POST advances it |
| `/token` | authorization code and refresh token exchange |
| `/revoke` | RFC 7009 revocation |

An unauthenticated request to `/mcp` answers 401 with a `WWW-Authenticate` header naming the resource metadata, and a client that speaks MCP authorization finds everything else from there. PKCE with `S256` is required; `plain` is refused. The only scope is `maccabi`. Tokens are opaque random strings kept as SHA-256 hashes, and an access token is bound to `http://127.0.0.1:PORT/mcp` as its audience — a token minted for any other resource is refused even if it verifies. Access tokens last an hour; refresh tokens last thirty days and rotate on every use, and replaying a spent one revokes every token that member holds.

The three form steps ask for the ID number, the phone to text, and the code: the same three things the CLI asks for, in the browser instead of the terminal. Each is a POST to `/authorize` carrying a CSRF token checked against a `SameSite=Lax` cookie scoped to that path. There is also a limit of five SMS per minute across all in-flight sign-ins. That one is not politeness — a local process that could drive the first step in a loop would burn the member's SMS budget straight into an account lockout.

`redirect_uri` is where an open redirector would live, so it is checked twice, once at registration and again at `/authorize`, and a mismatch renders an error page with no `Location` header at all rather than bouncing the browser anywhere. Loopback URIs may differ in port between registration and use and in nothing else, per RFC 8252 §7.3; `127.0.0.1`, `[::1]` and `localhost` all count as loopback, because real clients use all three. Anything else has to be one of two exact strings, the `vscode.dev` and `insiders.vscode.dev` redirect endpoints.

### Subjects, and why HTTP has its own credential files

Over stdio there is one member and one file. Over HTTP there can be several, so every access token carries a subject: the first sixteen bytes of `sha256("maccabi-mcp/subject/v1|" + memberId + "|" + memberIdCode)`, in hex. The subject picks the credential file, the serializer that keeps one member's calls from overlapping, and the set of tokens revoked when that member signs out.

It is derived from the member, not from the OAuth client, so two clients that authorize the same member share one credential file and one upstream session.

The stdio server reads the same `session.json` the CLI writes: signing in with the CLI signs in stdio MCP, and `maccabi logout` in either place signs out both. HTTP mode does not read `session.json` at all. A CLI login does not carry into HTTP mode, and a browser login does not carry into the CLI or into stdio. `maccabi logout --all` is what clears the HTTP side.

### Signing out has to reach both layers

When a read fails because Maccabi ended the session, the server deletes that member's credential file **and** revokes their OAuth tokens. Doing only the first strands the client: every call would answer `REAUTHENTICATION_REQUIRED`, the token in hand would still verify, and nothing would ever push the client into authorizing again. Revoking makes the next call a 401, which is the signal clients actually act on. `maccabi_logout` does both for the same reason.

## One code per SMS

A wrong code ends the challenge. The pending file is deleted before the error propagates, so a second `--code` returns `NO_PENDING_LOGIN` rather than retrying. This is deliberate: repeated OTP attempts against the same challenge are what lock a Maccabi account. Recovering costs one more SMS; a lockout costs a phone call to Maccabi.

## Trust boundary

Over stdio there is no auth between a client and the server, and adding a startup token would not create one — anything that can reach the server can already spawn `node dist/cli.js mcp` itself and get the same tools against the same `session.json`. The boundary is the file, and the file is protected by Unix permissions.

Over HTTP there is auth, and it is worth being exact about what it buys. It separates members, so one member's token cannot read another's records. It keeps the ID number and the SMS code out of the model's context, because the sign-in happens in the browser. And it gives the re-authorization loop something to revoke. It is not a defence against a hostile local process: such a process can register its own client and drive the `/authorize` form itself, and the only thing in its way is that the form needs the ID number and a code from the member's phone. It can also read `sessions/<subject>.json` directly and skip all of it.

What follows from that: on a machine you do not share, the exposure is any process running as you. On a shared machine, `0600` is what keeps other users out — which is why the load path warns when the mode has drifted. Anyone who can read a credential file has the member's medical records without needing the ID or the phone.
