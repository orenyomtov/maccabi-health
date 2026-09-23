import { pathToFileURL } from "node:url";

/**
 * The published `maccabi-health/mcp` surface: the server factory and its options, for a host that
 * wants to mount this server inside its own process. Everything else in `./tools` - the coverage
 * document, the flow catalog, the session lease and executor plumbing - is internal, shared with the
 * CLI and the loopback HTTP host, and free to change without a major bump.
 */
export { createMaccabiMcpServer } from "./tools";
export type { MaccabiMcpOptions } from "./tools";

/**
 * This module is a library entry, not an executable server. Pointing an MCP client at
 * `node .../dist/mcp.js` would otherwise start a process that exits at once with nothing on stdout,
 * which the client reports as `CONNECTION_CLOSED` with no cause. Say what to run instead.
 *
 * The check is deliberately narrow: it fires only when this file is the process entry point, so a
 * normal `import` of the module - the reason it exists - never reaches it. `process.argv[1]` is
 * absent when Node is fed a script on stdin or run with `--eval`, and `pathToFileURL` throws on
 * undefined, so it is guarded rather than assumed.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.stderr.write("maccabi-health/mcp is a library entry point, not a server. Run `maccabi mcp` (stdio) or `maccabi mcp --http` instead.\n");
  process.exit(2);
}
