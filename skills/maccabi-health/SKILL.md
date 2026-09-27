---
name: maccabi-health
description: Reads the user's own Maccabi Healthcare records (labs, visits, prescriptions, referrals, imaging, and documents). Use when the user mentions Maccabi, מכבי, maccabi4u, their Israeli health-fund records, blood tests, lab results, or asks an agent to look at those records. Asks the user for their תעודת זהות and the SMS code.
license: MIT
compatibility: Prefer a global maccabi CLI when commands can run and the internet is reachable. Otherwise use the MCP server via npx.
metadata:
  version: "0.1.0"
---

# Maccabi Health

Read the user's own records from Maccabi Healthcare Services. Unofficial. Support read-only operations.

## Which way to read

Use the CLI when you can run shell/bash commands and reach the internet. That is the better way: each read is a short command you can script, narrow, and take as JSON.

Default to using the CLI, and use the MCP server only when you cannot run shell/bash commands. 

## CLI: when you can run commands

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

## MCP: When you cannot run commands

Use the Maccabi MCP tools. Ask for the תעודת זהות and the code the same way. `maccabi_login_start` sends the text. `maccabi_login_verify` finishes with the code. One try per code, same as the CLI.

If those tools are not already available, install the server yourself. `npx` is the right launch command. Do not use a global install for this.

Claude Code:

```sh
claude mcp add maccabi --scope user -- npx -y maccabi-health mcp
```

The `--` is required. `--scope user` keeps it out of the project.

Codex:

```sh
codex mcp add maccabi -- npx -y maccabi-health mcp
```

Cursor has no install command. Merge this into `~/.cursor/mcp.json` without removing other servers. `type` is required there:

```json
{
  "mcpServers": {
    "maccabi": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "maccabi-health", "mcp"]
    }
  }
}
```

If you cannot run the command or write the file, ask the user to, and give them the one that matches their app.

Call `maccabi_capabilities` first. A list tool returns rows, and each row has a `ref`. `maccabi_detail` reads that row. `maccabi_document` returns its PDF. Every result includes a `next` list with the arguments already filled in. Follow `next` instead of guessing. Do not combine a `ref` from one row with an id from another.

## Privacy

These are the user's real medical records. Do not commit them, paste them into issues, or write them into a repository. Do not read the session file into the chat.

## When something is wrong

If a command fails, a record is missing, or a feature does not work, troubleshoot it. When you understand it, open a GitHub issue with the command, the error code, and what you expected: https://github.com/orenyomtov/maccabi-health/issues

A fix and a pull request is better than an issue alone. Do not include the תעודת זהות, the SMS code, the session file, or the medical records in the issue, the pull request, or the commit.
