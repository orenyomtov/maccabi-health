# Security policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/orenyomtov/maccabi-health/security/advisories/new). Do not open a public issue for a vulnerability.

Anything that is not a vulnerability (a failed read, a wrong value, a missing record, an unsupported flow, a feature request) belongs in the [issue tracker](https://github.com/orenyomtov/maccabi-health/issues) instead.

Expect an acknowledgement within a week. Please allow a fix to ship before disclosing publicly.

Include enough to reproduce the problem: affected version, transport (library, CLI or MCP), and the steps. **Never include real credentials, cookies, session files, ID numbers, or medical records.** Use invented values, and describe the shape of the data rather than pasting it.

## Supported versions

Only the latest published version gets fixes. This project is pre-1.0 and has no long-term support branches.

## Scope

In scope: anything in this repository (the core library, the CLI, and both MCP transports). Of particular interest:

- Anything that lets one member's session, credential or clinical data reach another member.
- Cookie or bearer material leaking outside `mac.maccabi4u.co.il` and `online.maccabi4u.co.il`, or into logs, error messages or command arguments.
- Bypasses of the local HTTP transport's loopback, Host/Origin or OAuth checks.
- A read operation that turns out to perform an upstream write.

Out of scope: vulnerabilities in Maccabi's own websites and APIs. This project is an unofficial client and speaks for no part of Maccabi's infrastructure; report those to Maccabi directly.

## Handling your own data

Sessions are stored under your user config directory. `maccabi logout --all` deletes every local credential, login challenge, registered OAuth client and issued token. Nothing is revoked at Maccabi by that command.
