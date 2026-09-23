# Contributing

Use [Node.js 22.19 or later](https://nodejs.org/en/download). Source stays TypeScript under `packages/`; the package contains built JavaScript and declarations.

```sh
git clone https://github.com/orenyomtov/maccabi-health.git
cd maccabi-health
npm ci
npm run check
```

`npm run check` typechecks, builds, and runs Vitest. Tests use synthetic data and local services only: no healthcare account, SMS, or real credentials. Live-account work needs deliberate authorization and stays out of the default suite.

Bugs, unsupported flows and feature requests go to the [issue tracker](https://github.com/orenyomtov/maccabi-health/issues); vulnerabilities go privately through [SECURITY.md](SECURITY.md). Open an issue before a large change, so the approach can be settled before the work.

## Architecture

Add operations in order: `packages/core`, then a thin CLI wrapper, then MCP. Core owns authentication, cookie transport, account-bound readers, and the anonymous public directory client, with no prompts or MCP transport. The CLI owns the session file in the user's config directory. MCP uses the official SDK for stdio and loopback Streamable HTTP; both share the CLI's lazy credential resolver.

## Upstream contracts

Implement only observed normal contracts from the official frontend or an authorized account observation. Record public-safe provenance in [API sources](docs/API-SOURCES.md). Keep unsupported branches explicit; do not guess endpoints or schemas. Establish a mutation's request, response, eligibility, and confirmation first. Reads must not silently acquire write effects: clinic availability already creates a scheduling conversation, and session renewal already changes expiry. Preserve source clinical wording, units, and dates. Distinguish an empty collection from authentication failure, an unavailable service, and an invalid response. Local list limits do not fetch further upstream pages.

## Privacy

Never put credentials, cookies, tokens, browser captures, medical records, raw responses, exports, or identifying examples in Git, issues, tests, or fixtures. Use invented fixtures, including for PDFs. Keep error messages free of upstream bodies, signed URLs, and account details. Intended clinical results and original documents are private; do not call them de-identified or anonymized.

## Release

Publishing runs only through [publish.yml](https://github.com/orenyomtov/maccabi-health/blob/main/.github/workflows/publish.yml) on GitHub `release.published`, using npm Trusted Publishing with GitHub OIDC. No token or local publishing path is configured.

The npm package must already exist, with Trusted Publisher set to GitHub owner `orenyomtov`, repository `maccabi-health`, workflow filename `publish.yml`, and direct publishing allowed. The package is currently absent; initial creation under the OIDC-only requirement remains unresolved, and the workflow fails before version stamping. See [Trusted publishers](https://docs.npmjs.com/trusted-publishers/) and the [existing-package prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

Once npm setup is complete, publish a GitHub release tagged `vX.Y.Z`, or a SemVer prerelease such as `v0.2.0-beta.1` with the prerelease checkbox selected. The tag and checkbox must agree; build metadata (`+suffix`) is rejected. Stable releases use npm `latest`; prereleases use `next`. The workflow checks, validates, stamps the runner's package version without a source commit, builds, packs, and publishes through OIDC.

For local verification, `npm pack` builds a tarball without publishing. Install that tarball and check CLI discovery and both MCP transports before a release.

## MCP Registry listing

`server.json` at the repository root describes this server for the [official MCP registry](https://modelcontextprotocol.io/registry/quickstart). Nothing has been published to it yet; these are the steps, and the order is not optional.

The registry proves npm ownership by fetching the published `package.json` and checking that its `mcpName` equals the `name` in `server.json`. Both currently read `io.github.orenyomtov/maccabi-health`, and the GitHub login in that namespace is what `mcp-publisher login github` grants. So **npm publish has to happen first** — the registry reads the published package, not the repository.

1. Publish to npm through the release workflow above.
2. Install the publisher: `brew install mcp-publisher`, or the release tarball from [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry).
3. `mcp-publisher login github` — device-code OAuth, grants the `io.github.orenyomtov/*` namespace.
4. `mcp-publisher publish` from the repository root.

What `server.json` has to satisfy, all of it enforced: `description` is capped at 100 characters (ours is 87); `version` and `packages[].version` must both equal the npm version, and `latest` is rejected; `packages[].identifier` is the npm package name; `name` must equal `package.json`'s `mcpName` exactly. `packageArguments` carries the `mcp` positional, because this package's bin is a CLI whose MCP server is a subcommand — without it a client would launch the binary and get the help index instead of a server. There are no `license`, `keywords` or `categories` fields. Published versions are immutable, so a mistake costs a version bump.

`server.json` is deliberately not in `package.json`'s `files`: the publisher reads it from the working tree, and the npm tarball has no use for it. It is also not version-stamped for you — `scripts/release.mjs` rewrites `package.json` and `package-lock.json` on the runner and nothing else — so bump both version fields in `server.json` in the repository before publishing a listing, or the registry will reject it for not matching the npm version.

The registry is still marked preview, with breaking changes and data resets expected. Listing is worth doing; depending on it is not.
