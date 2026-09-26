# Live validation runs

What has actually been exercised against the live service, as opposed to reconstructed from captures or covered by offline tests. Session lifetime has its own file, [Session lifetime research](SESSION-LIFETIME.md); everything else lands here.

No cookie value, token, member id, ID number or query string appears below, and no clinical content. Timestamps, durations, field names and HTTP statuses do.

## MCP server — 2026-09-23

First time either transport was driven live. Everything before this was unit and integration tests plus reading the SDK's behaviour.

### Stdio

`initialize` completed in roughly 250 ms. `serverInfo` came back as `{name: "maccabi-personal", version: "0.1.0"}`, and `tools/list` returned exactly 70 tools. All four login/logout tools are present over stdio, as designed; HTTP drops the two that take an identity number or an SMS code. (That name, that count and the tool names below are what the run saw. `serverInfo.name` was renamed to `maccabi-health` before publication, to match the npm package. The surface was reorganised afterwards around row references and the two universal resolvers, which is why the numbers here no longer match `tools/list` — see the [MCP guide](../MCP.md).)

### The renewal timer works

`RENEWAL_INTERVAL_MS = 240_000` in `packages/mcp/src/stdio.ts` had never been observed doing anything on a live session. It does.

Proving it took care, because a `keep-alive` was running on the same session and writing `session.json` on its own 240-second cadence. Running the server deliberately about 90 seconds out of phase separated the two: the file's mtime then showed two interleaved 240-second cadences rather than one. The falsification step is what settles it — after the client closed, no write appeared at the server's phase, while keep-alive kept ticking on schedule. The server's own ticks measured 237 s and 239 s apart, which is the interval plus the renewal's I/O, not a drift worth caring about.

### Stdout is clean

Any stray byte on stdout breaks stdio MCP outright, so this is worth stating rather than assuming. The only `process.stdout.write` in the MCP server source is on the `--help` path (`packages/mcp/src/main.ts`), which is never reached in server mode. Everything else — the startup line, renewal failures — goes to stderr. Confirmed live: stdout carried protocol messages and nothing else.

### Streamable HTTP

The listener binds 127.0.0.1 only. Its startup line goes to stderr; stdout stayed empty.

| Check | Result |
| --- | --- |
| RFC 9728 `/.well-known/oauth-protected-resource/mcp` | 200, with `resource`, `authorization_servers`, `scopes_supported`, `resource_name` |
| RFC 8414 `/.well-known/oauth-authorization-server` | 200 |
| Unauthenticated `POST /mcp` | 401 with `WWW-Authenticate: Bearer` carrying `error`, `scope`, `resource_metadata` |
| RFC 7591 dynamic client registration | 201 |

A full client connect was deliberately not attempted: it requires interactive browser consent, and that leg is the member's to drive, not a test harness's. So the discovery and challenge surface is verified live; the authorized tool call over HTTP is not.

## Document downloads — 2026-09-23

### Laboratory report PDF

`lab-report-pdf` on the CLI and `maccabi_document` with the row's ref and `variant: "laboratory_report"` both returned a valid PDF (`%PDF-1.4` … `%%EOF`). Ownership is settled by `assertListedTest` before the fetch: the body of `getresultsbyid` has no `request_id` to match against.

### Ownership binding is real, and it binds the pair

Two negative tests, both live:

- A mutated `doc_id` paired with a real `request_id` → `OWNER_MISMATCH`.
- A cross-row pair — `request_id` from one row, `doc_id` from another, both rows individually owned by the caller → `OWNER_MISMATCH`.

Mere membership in the owner's list is not enough; the pair has to name exactly one row. `assertListedTest` (`packages/core/src/readers/index.ts`) filters a freshly fetched owner-scoped listing on both fields and requires exactly one match. It also rejects before fetching anything (rejection was faster than a real download). The listing is refetched rather than trusted from the caller or from cache.

### `imaging_study` rows with no document are not a bug

Rows of type `imaging_study` legitimately come back with `result_files: null`. The source attaches no document to them, so `UNSUPPORTED_FLOW` is the correct answer and `has_document: false` is the correct listing. Maccabi hands those studies off to a separate browser viewer instead.

### The imaging viewer works end to end

Validated against a live member account on 2026-09-23, twice. All five CLI commands (`imaging-studies`, `imaging-study`, `imaging-image`, `imaging-thumbnail`, `imaging-pixels`) exit 0 against `meddreamy.maccabi4u.co.il`.

| Check | Result |
| --- | --- |
| Thumbnail | baseline JPEG, magic `ff d8 ff e0`, trailer `ff d9` |
| Pixel buffer length | matched `rows x columns x samplesPerPixel x (bitsAllocated / 8) x numberOfFrames` exactly; imaging pixel length checked on 8-bit single-frame instances with 1 and 3 samples |
| Stored vs decoded transfer syntax | split behaved as documented from the capture |
| `numberOfFrames` 0-in-structure / 1-in-metadata | split behaved as documented from the capture |
| `AUTH_REQUIRED` at any hop | none; `status --verify` afterwards returned `signed-in, verified: true` |
| Ownership negative control | `OWNER_MISMATCH` at all three UID levels, nothing written |

Mutating the study, series or image UID alone each produced `OWNER_MISMATCH`, and no file was written.

Viewer-origin cookies must not be saved into `session.json`. `exportSession` in `packages/core/src/transport.ts` omits them; `clearViewerCookies` in `packages/core/src/readers/imaging-viewer.ts` clears any already present before each handoff so a jar saved by an older build still replays cleanly.

### What the live run did not settle

- **Only 8-bit single-frame imaging is evidenced**, in both 1-sample and 3-sample form. CT and MR are 16-bit and may be multi-frame; neither has been read.
- **No viewer error response has ever been captured.** Not in the capture, and not in the live runs, which produced no errors to observe. Every status-code mapping in this client is therefore still an assumption about what those status codes usually mean.
- **Token and URL lifetimes are unmeasured.** How long the handoff URL stays valid, and whether the viewer token is single-use, are still unknown. A viewer session is established per study and re-established for each new reader.

See [Capabilities](../CAPABILITIES.md#imaging-studies-what-is-verified-and-what-is-not) for how this lands in the published caveats.

[Session lifetime research](SESSION-LIFETIME.md) · [Capabilities](../CAPABILITIES.md) · [CLI](../CLI.md) · [MCP transports](../MCP.md)
