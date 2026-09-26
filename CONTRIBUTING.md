# Contributing

The published package runs on [Node.js 22 or later](https://nodejs.org/en/download), but the build toolchain does not: tsdown loads `tsdown.config.ts` through Node's own type stripping, which is only unflagged from 22.18.0, and vitest wants 22.12.0. Develop on 22.19 or later, or on 24. Source is TypeScript under `packages/`; the published package contains built JavaScript and declarations.

```sh
git clone https://github.com/orenyomtov/maccabi-health.git
cd maccabi-health
npm ci
npm run check
```

`npm run check` typechecks, builds, and runs Vitest. Tests use synthetic data and local services only: no healthcare account, SMS, or real credentials. Live-account work needs deliberate authorization and stays out of the default suite.

Bugs, unsupported flows and feature requests go to the [issue tracker](https://github.com/orenyomtov/maccabi-health/issues); vulnerabilities go privately through [SECURITY.md](SECURITY.md). Open an issue before a large change so the approach can be settled first.

## Architecture

Add operations in order: `packages/core`, then a thin CLI wrapper, then MCP. Core owns authentication, cookie transport, account-bound readers, and the anonymous public directory client, with no prompts or MCP transport. The CLI owns the session file in the user's config directory. MCP uses the official SDK for stdio and loopback Streamable HTTP. Stdio resolves credentials lazily through `localSessionResolver` (the CLI's `session.json`); HTTP uses `subjectSessionResolver` and never reads `session.json`.

## Upstream contracts

Implement only observed normal contracts from the official frontend or an authorized account observation. Record public-safe provenance in [API sources](docs/API-SOURCES.md). Keep unsupported branches explicit; do not guess endpoints or schemas. Establish a mutation's request, response, eligibility, and confirmation first. Reads must not silently acquire write effects: clinic availability already creates a scheduling conversation, and session renewal already changes expiry. Preserve source clinical wording, units, and dates. Distinguish an empty collection from authentication failure, an unavailable service, and an invalid response. Local list limits do not fetch further upstream pages.

## Privacy

Never put credentials, cookies, tokens, browser captures, medical records, raw responses, exports, or identifying examples in Git, issues, tests, or fixtures. Use invented fixtures, including for PDFs. Keep error messages free of upstream bodies, signed URLs, and account details. Intended clinical results and original documents are private; do not call them de-identified or anonymized.

## Release

Every release after the first runs through [publish.yml](https://github.com/orenyomtov/maccabi-health/blob/main/.github/workflows/publish.yml) on GitHub `release.published`, using npm Trusted Publishing with GitHub OIDC. There is no token in CI and no scripted local publishing path.

A Trusted Publisher can only be attached to a package npm already knows about, so `0.1.0` is published by hand: the maintainer runs `npm publish --access public` locally, then sets the Trusted Publisher on npm to GitHub owner `orenyomtov`, repository `maccabi-health`, workflow filename `publish.yml`, with direct publishing allowed. `scripts/release.mjs` refuses to plan a release while the package is missing from the registry, which is why that first publish cannot go through the workflow. See [Trusted publishers](https://docs.npmjs.com/trusted-publishers/) and the [existing-package prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

From `0.1.1` onward, publish a GitHub release tagged `vX.Y.Z`, or a SemVer prerelease such as `v0.2.0-beta.1` with the prerelease checkbox selected. The tag and checkbox must agree; build metadata (`+suffix`) is rejected. Stable releases use npm `latest`; prereleases use `next`. The workflow checks, validates, stamps the runner's package version without a source commit, builds, packs, and publishes through OIDC.

For local verification, `npm pack` builds a tarball without publishing. Install that tarball and check CLI discovery and both MCP transports before a release.

## MCP Registry listing

`server.json` at the repository root describes this server for the [official MCP registry](https://modelcontextprotocol.io/registry/quickstart). Nothing has been published to it yet; these are the steps, and the order is not optional.

The registry proves npm ownership by fetching the published `package.json` and checking that its `mcpName` equals the `name` in `server.json`. Both currently read `io.github.orenyomtov/maccabi-health`, and the GitHub login in that namespace is what `mcp-publisher login github` grants. So **npm publish has to happen first**: the registry reads the published package, not the repository.

1. Publish to npm, following Release above.
2. Install the publisher: `brew install mcp-publisher`, or the release tarball from [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry).
3. `mcp-publisher login github`: device-code OAuth, grants the `io.github.orenyomtov/*` namespace.
4. `mcp-publisher publish` from the repository root.

What `server.json` has to satisfy, all of it enforced: `description` is capped at 100 characters (ours is 87); `version` and `packages[].version` must both equal the npm version, and `latest` is rejected; `packages[].identifier` is the npm package name; `name` must equal `package.json`'s `mcpName` exactly. `packageArguments` carries the `mcp` positional, because this package's bin is a CLI whose MCP server is a subcommand. Without it a client would launch the binary and get the help index instead of a server. There are no `license`, `keywords` or `categories` fields. Published versions are immutable, so a mistake costs a version bump.

`server.json` is deliberately not in `package.json`'s `files`: the publisher reads it from the working tree, and the npm tarball has no use for it. `scripts/release.mjs` does stamp its two version fields, but it does that on the runner and nothing is committed back, so the working tree you run `mcp-publisher` from still carries the old version. Bump both version fields in `server.json` in the repository before publishing a listing, or the registry will reject it for not matching the npm version.

The registry is still marked preview, with breaking changes and data resets expected. Listing is worth doing; depending on it is not.
