# Contributing

The published package runs on [Node.js 22 or later](https://nodejs.org/en/download). Installing it does not run any dependency install scripts: the only ones in this repo are dev dependencies. npm 12 skips those unless they are listed in the root `allowScripts`. `esbuild@0.28.2` is approved because `tsx` needs its postinstall to select a platform binary, and tests spawn `tsx`. `fsevents@2.3.3` is approved because it is the optional macOS watcher; it is not installed on Linux or Windows. A new dependency with an install script has to be added there, pinned to the version you reviewed. npm 10, which still ships with Node 22.19, ignores that field and runs every install script.

The build wants a newer Node than the published package does. tsdown declares `^22.18.0 || ^24.11.0 || >=26`, so `npm ci` on Node 24.4 warns `EBADENGINE`. That warning is not a failure: the build runs there. CI checks Node 22.19 and the current 24.x line. Source is TypeScript under `packages/`; the published package contains built JavaScript and declarations.

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

From `0.1.1` onward, publish a GitHub release tagged `vX.Y.Z`, or a SemVer prerelease such as `v0.2.0-beta.1` with the prerelease checkbox selected. The tag and checkbox must agree; build metadata (`+suffix`) is rejected. Stable releases use npm `latest`; prereleases use `next`. The workflow checks, validates, stamps the runner's package version without a source commit, builds, packs, and publishes through OIDC. A stable release then publishes that same version to the MCP registry. A prerelease does not.

Pushing to `main` updates one draft release. [release-draft.yml](https://github.com/orenyomtov/maccabi-health/blob/main/.github/workflows/release-draft.yml) sets the tag to the next patch and fills the notes from commits since the previous tag. Change the tag on the draft before publishing if this bump should not be a patch; the next push keeps a tag that is still ahead of the published release. Publish that draft to ship. You do not edit CHANGELOG.md. [changelog.yml](https://github.com/orenyomtov/maccabi-health/blob/main/.github/workflows/changelog.yml) commits the published notes into it. Notes on the draft are replaced on each push, so a hand edit belongs at publish time.

For local verification, `npm pack` builds a tarball without publishing. Install that tarball and check CLI discovery and both MCP transports before a release.

## MCP Registry listing

`server.json` at the repository root describes this server for the [official MCP registry](https://modelcontextprotocol.io/registry/quickstart). The registry stores that metadata only. Installs still come from npm.

[publish.yml](https://github.com/orenyomtov/maccabi-health/blob/main/.github/workflows/publish.yml) publishes the listing after a stable npm publish. The job already has `id-token: write`, and `mcp-publisher login github-oidc` uses that token. There is no second secret. `scripts/release.mjs` stamps both version fields in the runner's `server.json` before npm publish, and that is the file the publisher reads. Nothing is committed back. npm can accept the package before that version is visible, so the registry step waits until `npm view` returns it, then publishes once. `0.1.0` is not listed. `0.1.1` reached npm and missed the registry, because that wait was not in the workflow yet. Listing it is Actions, "Publish release", "Run workflow", version `0.1.1`. That run does not publish to npm. A release job cannot be re-run for a version npm already has.

The registry proves npm ownership by fetching the published `package.json` and checking that its `mcpName` equals the `name` in `server.json`. Both currently read `io.github.orenyomtov/maccabi-health`.

What `server.json` has to satisfy, all of it enforced: `description` is capped at 100 characters (ours is 87); `version` and `packages[].version` must both equal the npm version, and `latest` is rejected; `packages[].identifier` is the npm package name; `name` must equal `package.json`'s `mcpName` exactly. `packageArguments` carries the `mcp` positional, because this package's bin is a CLI whose MCP server is a subcommand. Without it a client would launch the binary and get the help index instead of a server. There are no `license`, `keywords` or `categories` fields. Published versions are immutable, so a mistake costs a version bump.

`server.json` is deliberately not in `package.json`'s `files`: the publisher reads it from the working tree, and the npm tarball has no use for it.

The registry is still marked preview, with breaking changes and data resets expected. Listing is worth doing; depending on it is not.
