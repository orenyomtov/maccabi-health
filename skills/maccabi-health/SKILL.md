---
name: maccabi-health
description: Reads the user's own Maccabi Healthcare records (labs, visits, prescriptions, referrals, imaging, and documents). Use when the user mentions Maccabi, מכבי, maccabi4u, their Israeli health-fund records, blood tests, lab results, or asks an agent to look at those records. Asks the user for their תעודת זהות and the SMS code.
license: MIT
compatibility: Shell and internet. Use the maccabi-health CLI. ChatGPT Work, including cloud and mobile, Cowork, and Claude Code can. If this chat cannot, name Claude Code, ChatGPT Work, Grok Build, or the Antigravity CLI.
metadata:
  version: "0.1.0"
---

# Maccabi Health

Read the user's own Maccabi Healthcare records. Unofficial. Support read-only operations.

Use the CLI when you can run shell commands and reach the internet. Each read is a short command you can script and even get the output as JSON. ChatGPT Work can do this in the cloud and on mobile, same as Cowork and Claude Code. Do not install MCP if you can run the CLI.

## Which app

If you cannot run the CLI, stop. Do not ask for their ID or the SMS code. Say one of these, and nothing else about install:

| You are | Tell the user |
| --- | --- |
| Claude.ai or Claude Desktop chat | This chat can't access Maccabi. Use Claude Code, or Claude Cowork. |
| ChatGPT, and not ChatGPT Work | This chat can't access Maccabi. Use ChatGPT Work. |
| grok.com or the Grok app | This chat can't access Maccabi. Use Grok Build or Cursor. |
| gemini.google.com | This chat can't access Maccabi. Use Antigravity. |

Claude Code, Cowork, Cursor, Codex, ChatGPT Work, Gemini CLI, Antigravity, and Grok Build run the CLI. 

`npx skills add orenyomtov/maccabi-health` installs this file for Claude Code, Codex, Cursor, and many other agents.

## CLI

Install once: `npm install -g maccabi-health`. Then every command is `maccabi-health ...`. If `maccabi-health` is not found, run `npx -y maccabi-health` with the same arguments.

To login, ask for their תעודת זהות and put those digits in the command. `000000000` is the placeholder for their ID number. 

```sh
maccabi-health login --id 000000000 --no-input
```

`--id` and `--code` are separate commands. Never pass both at once. If several phones are registered, the command lists numbered choices and sends nothing. Ask which one, then repeat with `--phone N`.

Ask them for the code from the text send to their phone. `000000` is a placeholder for the code they received.

```sh
maccabi-health login --code 000000 --no-input
```

One try per code. A wrong code ends that text. Do not submit it again. Ask if they want a new text and start over with `--id`. The code expires after ten minutes. After a successful login the session expires on its own after one hour, even if you keep using it. Then ask the same way again.

### Browser login (when the host blocks `--id` / `--code`)

Use this on Claude Code mobile. Also use it when the host refuses to run a command that contains an ID or SMS code (classifier, "exfiltration"), or when you prefer the user to enter the ID and the SMS code themselves so those values are not passed through you.

```sh
maccabi-health login --http
```

Give them the printed https URL and ask them to open it and sign in there. Ask them to tell you when they have finished. You can also poll with `maccabi-health status --verify --no-input` (exit 0 means the session is saved, exit 3 means not yet). The page stays up for ten minutes.

`maccabi-health` lists the commands. `maccabi-health help` is the full reference, about 6,000 tokens:

```text
maccabi-health help COMMAND   usage, flags, notes and caveats for one command (add --json)
maccabi-health help           every command in full (add --json for the discovery document)
```

Add `--no-input` on every command except `mcp`. `--json` is only for `help` and `keep-alive`.

Take those ids from that result. Do not invent one, and do not mix an id from one row with an id from another. `--limit` only shortens the result you already fetched. Before the first read, `maccabi-health status --verify --no-input` checks the login. Exit 3 means sign in again. The error on stderr is JSON, with `code` and `exitCode`.

You can read labs and one test's past values, prescriptions, visits, referrals, doctor correspondence, vaccinations, certificates, billing summaries, imaging-study metadata, and the original PDFs the portal serves. Keep the original Hebrew unless the user asks for a translation. Summarize only what came back.

Recent blood tests: `maccabi-health latest-labs --no-input`, then `maccabi-health help lab-comparison --json` and call it with a `test_id` from that result. `maccabi-health labs --limit 10 --no-input` is the longer list. PDF commands take `--out` and write a file. Do not fetch document URLs yourself.

## MCP

Use this only when the maccabi-health tools are already available and you cannot run a shell. Do not ask the user to install MCP. If the tools are not there, use the sentence in the table above.

Same questions: תעודת זהות, then the code. `maccabi_login_start` sends the text. `maccabi_login_verify` finishes it. One try per code.

A list row carries a `ref`. `maccabi_detail` reads it, `maccabi_document` returns its PDF, and `next` already has the following arguments. Follow `next`. Do not combine a `ref` from one row with an id from another.

## Privacy

These are real medical records. Handle them with the appropriate care.

## When something is wrong

Troubleshoot a failed command, a feature, or a feature that does not work. Then open an issue with the command, the error code, and what you expected: https://github.com/orenyomtov/maccabi-health/issues

Even better, if you can, fix the problem and submit a pull request to share the fix with everyone!
