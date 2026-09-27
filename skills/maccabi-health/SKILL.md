---
name: maccabi-health
description: Reads the user's own Maccabi Healthcare records (labs, visits, prescriptions, referrals, imaging, and documents). Use when the user mentions Maccabi, מכבי, maccabi4u, their Israeli health-fund records, blood tests, lab results, or asks an agent to look at those records. Asks the user for their תעודת זהות and the SMS code.
license: MIT
compatibility: Prefer a global maccabi CLI when commands can run and the internet is reachable. Otherwise use the MCP server via npx.
metadata:
  version: "0.1.0"
---

# Maccabi Health

Read the user's own records from Maccabi Healthcare Services. Unofficial. Read-only: do not book, renew prescriptions, submit requests, pay, or change the profile.

Talk to the user in plain language. Do not mention terminals, flags, or commands. Ask for their תעודת זהות, which phone to text, and the code from the text.

## Which way to read

Use the CLI when you can run commands and reach the internet. That is the better way: each read is a short command you can script, narrow, and take as JSON.

Use the MCP server only when you cannot run commands. Connect that server with `npx`, not a global install.

## Install the CLI

Once, before the first command:

```sh
npm install -g maccabi-health
```

After that every command is `maccabi ...`. If `maccabi` is not found, the install did not land on PATH. Use `npx --yes --package maccabi-health maccabi` with the same arguments.

## Sign in

Ask for their תעודת זהות, the Israeli ID number. Put those digits in the command. `000000000` is a placeholder, not a value. Do not send it.

```sh
maccabi login --id 000000000 --json --no-input
```

`--id` and `--code` are two separate commands. Never pass both at once.

If several phones are registered, the command prints numbered choices and sends nothing. Ask which phone, then run the same command again with `--phone N`, where `N` is the choice they picked.

When the text has been sent, ask for the code. Put those digits in place of `000000`. Do not send the zeros.

```sh
maccabi login --code 000000 --json --no-input
```

One try per code. A wrong code ends that text. Do not submit it again. Ask if they want a new text, and start over with `--id`. The code expires after ten minutes. A finished login lasts about an hour. When it ends, ask for the תעודת זהות and a new code the same way.

## How to find a command

`maccabi` prints one line per command. Read that index before guessing a name.

`maccabi help COMMAND --json` is one command: its flags, and which ids to copy from an earlier result. Use that. `maccabi help` with no command is the whole catalog. Do not pull it into context unless the index is not enough.

Add `--json --no-input` to every command except `mcp`. `--json` is one compact JSON object on stdout. On failure, stdout is empty and stderr is `{"error":{"code","message","exitCode"}}`. Exit 3 means sign in again. Exit 2 means the flags are wrong. Read `maccabi help` for that command.

Copy ids out of JSON you already hold. Do not invent them, and do not pair an id from one row with an id from another.

`--limit` and `--offset` slice a response that was already fetched. They do not ask Maccabi for older pages.

Check the session before the first read:

```sh
maccabi status --verify --json --no-input
```

## What you can read

Laboratory results and one test's past values, prescriptions, visits, referrals, doctor correspondence, vaccinations, certificates, billing summaries, imaging-study metadata, and the original PDFs the portal serves. Wording stays in the original Hebrew unless the user asks for a translation. Summarize only what the command returned.

Recent blood tests:

```sh
maccabi latest-labs --json --no-input
```

Then `maccabi help lab-comparison --json`, and call `lab-comparison` with a `test_id` from that result. `maccabi labs --limit 10 --json --no-input` is the longer test list. A PDF command writes a file with `--out`. Do not fetch document URLs yourself.

## When you cannot run commands

Use the Maccabi MCP tools. Ask for the תעודת זהות and the code the same way. `maccabi_login_start` sends the text. `maccabi_login_verify` finishes with the code. One try per code, same as the CLI.

If those tools are not already connected, add this server. `npx` is the right command here:

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

Call `maccabi_capabilities` first. A list tool returns rows, and each row has a `ref`. `maccabi_detail` reads that row. `maccabi_document` returns its PDF. Every result includes a `next` list with the arguments already filled in. Follow `next` instead of guessing. Do not combine a `ref` from one row with an id from another.

## Privacy

These are the user's real medical records. Do not commit them, paste them into issues, or write them into a repository. Do not read the session file into the chat.
