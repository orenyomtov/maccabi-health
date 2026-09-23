# MCP

The same operations are available over standard MCP stdio or local Streamable HTTP. Both use the official MCP SDK. Both resolve the saved credential lazily, on the first account tool call: stdio from the CLI's own `session.json`, HTTP from a per-member file it keeps itself.

For account reads, sign in once. In your own terminal:

```sh
maccabi login
```

Over stdio, `maccabi_login_start`, `maccabi_login_verify`, `maccabi_login_status` and `maccabi_logout` do the same from a client. The first two are the only tools that take an identity number or an SMS code, and both values then sit in the model's context, so use the terminal when you have one. Over HTTP those two tools do not exist: the sign-in runs in your own browser as part of authorization, and only `maccabi_login_status` and `maccabi_logout` are registered. Starting either transport does not log in and does not read or write the saved credential. Account tools request it only when called. Public directory tools need no account. Missing or expired account sessions return login guidance; they never send SMS or retry a login by themselves.

Use a client and model you trust with health data. Original clinical text and PDFs may identify the patient. Private credential and document-routing fields stay internal. Structured output is not anonymized or de-identified.

## Stdio

Add this entry to your MCP client's configuration:

```json
{
  "mcpServers": {
    "maccabi": {
      "command": "npx",
      "args": ["-y", "maccabi-health", "mcp"]
    }
  }
}
```

`npx` resolves this package's single bin, `maccabi`, and passes `mcp` through to it. With a global install, `"command": "maccabi"` and `"args": ["mcp"]` do the same thing without the lookup; if your client cannot resolve the installed bin, use its absolute path. The [README](../README.md#if-your-agent-speaks-mcp) has the per-client variants: Claude Code, Claude Desktop, Cursor, VS Code, Codex and the Windows `cmd /c` wrapper.

Preserve other `mcpServers` entries. Stdout carries only MCP protocol messages. The server stops when the client closes stdin, and on `SIGINT` or `SIGTERM`: it closes the transport, then lets the process exit on its own, so nothing cuts off a reply still being written.

## Streamable HTTP

```sh
maccabi mcp --http
```

Connect your client to `http://127.0.0.1:8765/mcp`. The listener is fixed to loopback. It uses the official SDK Streamable HTTP handler and Node adapter, with localhost Host/Origin checks. Hosting, TLS and tunnels are outside this project's scope.

If something else already owns 8765, choose another port:

```sh
maccabi mcp --http --port 9000
```

`MACCABI_MCP_PORT` does the same for a client configuration that cannot pass arguments, and `--port` wins when both are set. The value has to be a whole number from 1 to 65535; anything else fails at startup naming what was wrong, rather than binding something unexpected. Both need `--http`: the stdio transport has no port. `--http` and `--port` are the only server flags; there is no server config file. Every URL the server publishes, including the OAuth discovery documents, is built from the port it actually bound, so the rest of the flow needs no further configuration.

The endpoint requires OAuth 2.1, so the client has to be one that speaks MCP authorization: Claude Code, VS Code and Claude Desktop all do. There is nothing to configure: the first request gets a 401 pointing at `/.well-known/oauth-protected-resource/mcp`, the client registers itself, and a browser window opens on this server's own sign-in page asking for your ID number, which phone to text, and the code. Nothing about that leg passes through the model. The full flow, the endpoint table and the redirect rules are in the [authentication guide](AUTH.md#mcp).

`--http` writes two more things into the config directory: `oauth.json`, holding registered clients and hashed tokens, and `sessions/<subject>.json`, one credential file per member who has signed in through the browser. These are separate from the CLI's `session.json`. A CLI login does not sign in the HTTP server, and vice versa. `maccabi logout --all` clears them.

The stdio server renews the saved session on a 240-second timer, because it is the only long-lived process here. A CLI command is a new process that cannot outlive its own run, and Maccabi's idle timeout kills a session between commands. The timer shares the tools' `exclusive()` executor, so a renewal never overlaps a tool call on the same session, and it saves the refreshed cookies through the same lease. It is `unref`'d, so it never keeps the process alive, and it is cleared when the server closes. A tick with no stored session does nothing and tries again later. A tick that fails stops the timer and writes one line to stderr; it never deletes the stored session, because replacing that credential costs the member an SMS. `--http` gets no such timer: it is multi-user with per-member leases, where a single global timer would be meaningless.

The timer was confirmed firing against a live session on 2026-09-23, with ticks 237 and 239 seconds apart and a falsification step ruling out a concurrent CLI `keep-alive` as the source of the writes. It holds off Maccabi's idle timeout and does not extend the absolute cap, so a long-running stdio server still loses its session roughly an hour after login and needs a fresh `maccabi login`. Details in [Live validation runs](https://github.com/orenyomtov/maccabi-health/blob/main/docs/research/LIVE-VALIDATION.md) and [Session lifetime research](https://github.com/orenyomtov/maccabi-health/blob/main/docs/research/SESSION-LIFETIME.md).

The SDK builds a fresh server instance per HTTP request, so the `exclusive()` serializer cannot live inside that factory or it would serialize nothing. `startLocalHttpMcp` keeps a `Map<string, Executor>` for the lifetime of the handle and passes the matching executor in as `runExclusive`, so overlapping tool calls take turns instead of reading the same session file and clobbering each other's rotation. The key is the authenticated subject, so two members never queue behind each other. The map is cleared when the handle closes.

## How the tools fit together

Call `maccabi_capabilities` first. It needs no account, makes no upstream request, and returns what this server can read, the journeys below, and where coverage stops. That is cheaper than reading 38 tool descriptions and guessing.

The shape is three rules:

1. **A list tool returns rows, and every row carries an opaque `ref`.** `maccabi_tests`, `maccabi_past_visits`, `maccabi_prescriptions`, `maccabi_medical_certificates` and the rest.
2. **`maccabi_detail` reads the record behind a ref; `maccabi_document` returns its original PDF.** That is the whole per-row surface. A row whose only content is a document says so and names the other tool. `maccabi_report` covers the account-wide PDFs that belong to no row at all.
3. **Every result carries a `next` list:** the calls that sensibly follow it, each with its arguments already filled in from that result. Follow it instead of guessing. Where a step applies to every row, the arguments come from the first one and `why` says so.

A `ref` holds everything its follow-up needs: a request id and its document id, a local reference and the date range it was listed in, a report reference and its period. That is the point of it. Pairing an identifier from one row with an identifier from another is not expressible, so the mismatch the ownership check used to catch after the fact cannot be written down in the first place. The raw identifiers are still in every row, for reading, logging and correlating against the CLI, which continues to take them directly.

Two optional selectors reach inside a row, and both are copied verbatim from a payload you already hold: `test_id` narrows a laboratory ref to one analyte, and `reference` picks one attachment out of a row that lists several.

Refs are stateless. The same row mints the same token every time, nothing expires, and nothing is stored server-side, so a token survives a restart, a request-scoped HTTP server instance and a compacted conversation.

## Worked journeys

**Nothing to a lab report PDF.** `maccabi_tests` → take a row's `ref` → `maccabi_detail` with that ref for the values, units and reference ranges → `maccabi_document` with the same ref and `variant: "laboratory_report"` for the original PDF. Without `variant` you get whatever document the row attaches, which is what `has_document` reports.

**Nothing to one analyte's history.** `maccabi_latest_labs` → the result carries a `ref` for the whole latest-results view, and each group lists its tests → `maccabi_detail` with that ref and any `group_values[].test_id`. Comparison reaches further back than the summary list. `maccabi_document` with the same pair and `variant: "comparison_graph"` gives the source's own graph PDF. `maccabi_followed_labs` works identically for followed tests.

**Nothing to an imaging study's pixel data.** `maccabi_imaging_studies` → a row's `ref` → `maccabi_detail` returns the series and instances from the external viewer → `maccabi_detail` again with that ref plus a `series_instance_uid` and `sop_instance_uid` from the tree, for one image's DICOM metadata. The image bytes stop there on purpose: the preview JPEG and the raw pixel buffer are megabyte-scale binaries a model cannot use, so `maccabi imaging-thumbnail` and `maccabi imaging-pixels` write them to a file in the member's own terminal instead.

**Nothing to upcoming appointments.** `maccabi_upcoming_appointments` → a row's `ref` → `maccabi_detail` for the provider's contacts and the visit instructions. Instruction links are returned as validated HTTP(S) links and never fetched. Past visits are `maccabi_past_visits`, which is a different tool because it is a different question.

**A document attached to a visit.** `maccabi_past_visits` → a row's `ref` → `maccabi_detail`, which exposes a `pdf_reference` on each eligible attachment → `maccabi_document` with the visit's ref and that `reference`. The ref alone, with no `reference`, gives the visit-summary PDF.

## How many tools this is, and where that bites

This server registers 38 tools. That is more than some clients want.

Cursor caps the agent at roughly 40 tools counted across every enabled MCP server, not per server. The limit is not in Cursor's own MCP documentation, but users report the agent saying so and report the count being cumulative, so treat the number as approximate and the behavior as real: past the cap Cursor may silently stop offering some tools, and there is no error. The tool is simply not there. At 38 this server fits under the cap on its own, with almost nothing to spare: enable a second server of any size alongside it and you are over. Enabling it on its own is the workaround. Anthropic's own guidance points the same way from a different direction: it puts the threshold for needing on-demand tool loading at 10 or more tools, or tool definitions over 10k tokens, and notes that model tool-selection accuracy degrades past 30 to 50 tools.

Two responses:

- **In Cursor, use the CLI.** Cursor's agent has a shell, the CLI has no tool cap to hit, and bare `maccabi` is a ~5 KB index rather than ~33 KB of tool schemas. See [the CLI guide](CLI.md).
- **Everywhere else, the count follows from the design.** The surface is already consolidated: one detail tool and one document tool cover every row-scoped read, and one account tool covers the member's own record, which is why 38 covers what would otherwise be well over a hundred endpoints. `maccabi_capabilities` exists so a client does not have to read all 38 descriptions to find its way.

There is currently no flag to register a subset. If a client of yours needs one, [say so in an issue](https://github.com/orenyomtov/maccabi-health/issues).

## Results and limits

Tools advertising `offset`/`limit` default to 20 records and accept at most 50, sliced from a newly fetched response. This does not fetch further upstream pages. JSON is capped at 128 KiB; original PDFs at 2 MiB. Some core PDF methods also cap documents at 2 MiB. Document tools embed the bytes directly; their document URI is not a persistent download link. Oversized results fail explicitly.

Exhaust `page.nextOffset` where present, preserve dates, values, units and reference ranges, and report available coverage without claiming complete history. Embedded PDF bytes need a PDF-capable client; this server does not extract text or run OCR. Download success alone does not establish that an agent read the document.

An error result carries guidance and, where there is one, its own `next`. A ref that will not decode returns `INVALID_REFERENCE`; a ref aimed at the wrong tool returns `INVALID_SELECTION` and names the tool that does have what was asked for. Both are decided before any session is resolved, so neither costs an upstream request.

The `maccabi://service/coverage` resource holds the same coverage text `maccabi_capabilities` embeds; see the [capability reference](CAPABILITIES.md) for the full per-operation table.

The imaging journey above reads the external viewer Maccabi hands scans off to. That path has been executed live end to end on one ultrasound study, but only 8-bit ultrasound is evidenced and no error response from the viewer has ever been captured, so every status-code mapping in it is still an assumption. The [capability reference](CAPABILITIES.md) lists what remains unverified.

Clinic availability starts a scheduling conversation, and session renewal changes expiry state. Their tool annotations reflect those effects. Neither books an appointment; renewal does not guarantee continued authentication and cannot reset a browser idle timer.

[CLI guide](CLI.md) · [API sources](API-SOURCES.md) · [Live validation runs](https://github.com/orenyomtov/maccabi-health/blob/main/docs/research/LIVE-VALIDATION.md) · [Contributing](../CONTRIBUTING.md)
