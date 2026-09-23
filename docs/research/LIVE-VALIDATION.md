# Live validation runs

What has actually been exercised against the live service, as opposed to reconstructed from captures or covered by offline tests. Session lifetime has its own file, [Session lifetime research](SESSION-LIFETIME.md); everything else lands here.

No cookie value, token, member id, ID number or query string appears below, and no clinical content. Timestamps, byte counts, durations, field names and HTTP statuses do.

## MCP server — 2026-09-23

First time either transport was driven live. Everything before this was unit and integration tests plus reading the SDK's behaviour.

### Stdio

`initialize` completed in roughly 250 ms. `serverInfo` came back as `{name: "maccabi-personal", version: "0.1.0"}`, and `tools/list` returned exactly 70 tools. All four login/logout tools are present over stdio, as designed; HTTP drops the two that take an identity number or an SMS code. (That name, that count and the tool names below are what the run saw. `serverInfo.name` was renamed to `maccabi-health` before publication, to match the npm package. The surface was reorganised afterwards around row references and the two universal resolvers, which is why the numbers here no longer match `tools/list` — see the [MCP guide](../MCP.md).)

### The renewal timer works

`RENEWAL_INTERVAL_MS = 240_000` in `packages/mcp/src/stdio.ts` had never been observed doing anything on a live session. It does.

Proving it took care, because a `keep-alive` was running on the same session and writing `session.json` on its own 240-second cadence. Running the server deliberately about 90 seconds out of phase separated the two: the file's mtime then showed two interleaved 240-second cadences rather than one. The falsification step is what settles it — after the client closed at 11:21:52Z, no write appeared at the server's phase around 11:24:45Z, while keep-alive kept ticking on schedule. The server's own ticks measured 237 s and 239 s apart, which is the interval plus the renewal's I/O, not a drift worth caring about.

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

### The laboratory report PDF works now

`lab-report-pdf` on the CLI and `maccabi_lab_report_pdf` over MCP (now `maccabi_document` with the row's ref and `variant: "laboratory_report"`) both returned 139,428 bytes, starting `%PDF-1.4` and ending in a valid `%%EOF` trailer.

Worth recording why it did not work before, because the shape of the bug is the kind that survives review. A guard compared `data.request_id !== requestId` against the `getresultsbyid` response. That response has no `request_id` key at all — its top-level keys are `corona_hash`, `corona_t`, `execute_date`, `hash`, `is_partial`, `is_read`, `referrer_name`, `results`, `show_print_corona_english_report`, `time_stamp`. The comparison was therefore always true, and both PDF functions threw for every row of every account. It read like an ownership check and enforced nothing; it only ever produced a false negative. Ownership is now settled by `assertListedTest` before the fetch, and the two call sites carry a comment saying that body has no `request_id` to match against.

### Ownership binding is real, and it binds the pair

Two negative tests, both live:

- A mutated `doc_id` paired with a real `request_id` → `OWNER_MISMATCH`.
- A cross-row pair — `request_id` from one row, `doc_id` from another, both rows individually owned by the caller → `OWNER_MISMATCH`.

The second one is the interesting case. Mere membership in the owner's list is not enough; the pair has to name exactly one row. `assertListedTest` (`packages/core/src/readers/index.ts`) filters a freshly fetched owner-scoped listing on both fields and requires exactly one match.

It also rejects before fetching anything, which the timings show: 811 ms for the rejection against 2948 ms for a real download. The listing is refetched rather than trusted from the caller or from cache.

### `imaging_study` rows with no document are not a bug

Rows of type `imaging_study` legitimately come back with `result_files: null`. The source attaches no document to them, so `UNSUPPORTED_FLOW` is the correct answer and `has_document: false` is the correct listing. Maccabi hands those studies off to a separate browser viewer instead.

Recorded here so that a future reader hitting `UNSUPPORTED_FLOW` on an imaging row does not file it as a regression and go looking for a download path that was never there.

### The imaging viewer works end to end

A capture recorded the whole handoff, so the `imaging-studies` / `imaging-study` / `imaging-image` / `imaging-thumbnail` / `imaging-pixels` commands and the matching MCP tools were written from it and tested offline. On 2026-09-23 the chain was executed against the live service, twice, and all five CLI commands exit 0 against `meddreamy.maccabi4u.co.il`. The account's one study came back with one series and 11 instances.

| Check | Result |
| --- | --- |
| Thumbnail bytes | 6,631-byte baseline JPEG, magic `ff d8 ff e0`, trailer `ff d9` |
| Pixel buffer length | matched `rows x columns x samplesPerPixel x (bitsAllocated / 8) x numberOfFrames` exactly on all 11 instances |
| RGB instance | `samplesPerPixel: 3`, 4,516,320 bytes, arithmetic exact |
| Secondary Capture instance | served: exit 0, 7,417-byte JPEG |
| Stored vs decoded transfer syntax | split behaved exactly as the capture documented |
| `numberOfFrames` 0-in-structure / 1-in-metadata | split behaved exactly as the capture documented |
| `AUTH_REQUIRED` at any hop | none; `status --verify` afterwards returned `signed-in, verified: true` |
| Ownership negative control | `OWNER_MISMATCH` at all three UID levels, nothing written |

Two of these are worth more than a table row. The **pixel arithmetic is now confirmed for 3-sample data**, not just 1-sample: one instance is RGB at `samplesPerPixel: 3`, and its 4,516,320 bytes match the computed length exactly, so the multiplication is not merely untested arithmetic that happened to work because one of its factors was 1. And the **Secondary Capture instance works**. It was previously documented as untested, for the good reason that Maccabi's own viewer skips it — the SPA's `features.summaryThumbnailsForSopClasses` config is why. That was the viewer's choice, not the endpoint's: asked directly, it serves the object.

The ownership negative control was run at each UID level separately. Mutating the study, the series or the image UID alone each produced `OWNER_MISMATCH`, and no file was written in any of the three.

### The bug the live run found: viewer cookies poisoned the session jar

The first live attempt worked and every imaging call after it failed `TOKEN_UNAVAILABLE`. The handoff mints its own F5 APM and MedDream cookies on the viewer origin, and `exportSession` was serialising them into `session.json` along with the portal's. Replayed on the next run, the viewer's still-live F5 session short-circuited the SAML leg, which is the leg that mints the token — so the chain completed without ever producing one.

Fixed in two places, because the saved jars already written needed to keep working: `exportSession` in `packages/core/src/transport.ts` no longer serialises viewer-origin cookies, and `packages/core/src/readers/imaging-viewer.ts` calls `clearViewerCookies` before each handoff so a jar saved by an older build still replays cleanly. Re-verified live: 4 consecutive successes, then 3 more.

This is the argument for running the thing rather than testing it. Offline fixtures start from an empty jar every time, so no synthetic test could have produced the state that broke it.

### What the live run did not settle

- **Only 8-bit ultrasound is evidenced**, now in both 1-sample and 3-sample form, and single-frame throughout. CT and MR are 16-bit and may be multi-frame; neither has been read.
- **No viewer error response has ever been captured.** Not in the capture, and not in the live runs, which produced no errors to observe. Every status-code mapping in this client is therefore still an assumption about what those status codes usually mean.
- **Token and URL lifetimes are unmeasured.** How long the handoff URL stays valid, and whether the viewer token is single-use, are still unknown. A viewer session is established per study and re-established for each new reader.

See [Capabilities](../CAPABILITIES.md#imaging-studies-what-is-verified-and-what-is-not) for how this lands in the published caveats.

[Session lifetime research](SESSION-LIFETIME.md) · [Capabilities](../CAPABILITIES.md) · [CLI](../CLI.md) · [MCP transports](../MCP.md)
