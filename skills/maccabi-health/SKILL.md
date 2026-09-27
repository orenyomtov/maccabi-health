---
name: maccabi-health
description: Reads the user's own Maccabi Healthcare records (labs, visits, prescriptions, referrals, imaging, and documents). Use when the user mentions Maccabi, מכבי, maccabi4u, their Israeli health-fund records, blood tests, lab results, or asks an agent to look at those records. Asks the user for their ID number and the SMS code.
license: MIT
compatibility: Prefer the CLI when commands can run and the internet is reachable. Otherwise use the MCP server.
metadata:
  version: "0.1.0"
---

# Maccabi Health

Read the user's own records from Maccabi Healthcare Services. Unofficial. Read-only: do not book, renew prescriptions, submit requests, pay, or change the profile.

Talk to the user in plain language. Do not mention terminals, flags, or commands. Ask for things by name: their ID number, which phone to text, the code from the text.

## Which way to read

Use the CLI when you can run commands and reach the internet. That is the better way: each read is a command you can script, narrow, and take as JSON.

Use the MCP server only when you cannot run commands.

## Sign in

Ask for their ID number, then send the text yourself. Do not tell them to run anything.

```sh
npx --yes --package maccabi-health maccabi login --id ID --json --no-input
```

Use `maccabi` instead of the `npx` line when it is already installed. `--id` and `--code` are two separate commands. Never pass both at once.

If several phones are registered, the command prints numbered choices and sends nothing. Ask which phone, in those words, then run the same command with `--phone N` set to the number they picked.

When the text has been sent, ask for the code. Then:

```sh
npx --yes --package maccabi-health maccabi login --code CODE --json --no-input
```

One try per code. A wrong code ends that text. Do not submit it again. Ask if they want a new text, and start over with `--id`. The code expires after ten minutes. A finished login lasts about an hour. When it ends, ask for the ID and a new code the same way.

## When you cannot run commands

Use the Maccabi MCP tools. Ask for the ID and the code the same way. `maccabi_login_start` sends the text. `maccabi_login_verify` finishes with the code. One try per code, same as the CLI.

If those tools are not already connected, add this server and then use them:

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

Call `maccabi_capabilities` before guessing which tool to use.

## Read

On the CLI, run `maccabi` for the command index and `maccabi help COMMAND --json` before guessing flags. Add `--json --no-input` on every command except `mcp`.

Check the session before the first read:

```sh
maccabi status --verify --json --no-input
```

For blood tests, start with `maccabi labs` and follow the ids that command returns into the detail and comparison commands named in its help. Preserve the source values, units, dates, and Hebrew wording. Summarize only what came back.

Original documents are files written by the PDF commands. Do not fetch document URLs yourself.

## Privacy

These are the user's real medical records. Do not commit them, paste them into issues, or write them into a repository. Do not read the session file into the chat.
