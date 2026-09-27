---
name: maccabi-health
description: Reads the user's own Maccabi Healthcare records (labs, visits, prescriptions, referrals, imaging, and documents) with the maccabi CLI. Use when the user mentions Maccabi, מכבי, maccabi4u, their Israeli health-fund records, blood tests, lab results, or asks an agent to look at those records.
license: MIT
compatibility: Requires a shell. The user signs in with maccabi login in their own terminal.
metadata:
  version: "0.1.0"
---

# Maccabi Health

Read the user's own records from Maccabi Healthcare Services. Unofficial. Read-only: do not book, renew prescriptions, submit requests, pay, or change the profile.

## Sign in

Do not ask for an ID number or an SMS code in the chat. Tell the user to run this in their own terminal and come back when it finishes:

```sh
npx --yes --package maccabi-health maccabi login
```

If `maccabi` is already on PATH, `maccabi login` is the same command. A finished login keeps the session alive for about an hour. It cannot last longer. When commands start failing authentication, the user logs in again the same way.

## Read

Prefer the CLI. Run `maccabi` for the command index and `maccabi help COMMAND --json` before guessing flags. Add `--json --no-input` on every command except `mcp`.

Check the session before the first read:

```sh
maccabi status --verify --json --no-input
```

For blood tests, start with `maccabi labs` and follow the ids that command returns into the detail and comparison commands named in its help. Preserve the source values, units, dates, and Hebrew wording. Summarize only what the commands returned.

Original documents are files written by the PDF commands. Do not fetch document URLs yourself.

## Privacy

These are the user's real medical records. Do not commit them, paste them into issues, or write them into a repository. The session file is a credential. Do not read it into the chat.
