import { LOCAL_HTTP_PORT, PORT_VARIABLE, resolveHttpPort } from "./port";
import { startLocalMcp } from "./stdio";

export const MCP_USAGE = "Usage: maccabi mcp [--http [--port N]]\n";

/**
 * Resolves when the stdio client disconnects or the process is asked to stop, so the command returns
 * an exit code instead of leaving a top-level await unsettled for the event loop to drain — which
 * Node reports on stderr and exits 13 for. Nothing here writes to stdout: that is the MCP channel,
 * and nothing calls `process.exit`, which would cut off a reply the transport is still flushing.
 */
export function awaitStdioShutdown(
  handle: { close(): Promise<void> },
  input: NodeJS.EventEmitter = process.stdin,
): Promise<number> {
  return new Promise<number>(resolve => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      input.off("end", stop);
      input.off("close", stop);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void handle.close().then(() => resolve(0), () => resolve(1));
    };
    // The SDK's stdio transport only listens for `data` and `error`, so end-of-input is ours to notice.
    input.once("end", stop);
    input.once("close", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function runMcp(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(
      `${MCP_USAGE}Run the MCP server over stdio, or use --http for the local Streamable HTTP endpoint.\n` +
      `--port N picks the HTTP port (1-65535, default ${LOCAL_HTTP_PORT}); ${PORT_VARIABLE} does the same and the flag wins. Both need --http.\n`,
    );
    return 0;
  }
  if (args[0] === "--http") {
    const rest = args.slice(1);
    const withPort = rest.length === 2 && rest[0] === "--port" && !rest[1].startsWith("-");
    if (rest.length && !withPort) {
      process.stderr.write(MCP_USAGE);
      return 2;
    }
    const resolved = resolveHttpPort(withPort ? rest[1] : undefined);
    if ("error" in resolved) {
      process.stderr.write(`${resolved.error}\n`);
      return 2;
    }
    const port = resolved.port;
    const { startLocalHttpMcp, LOCAL_HTTP_HOST, LOCAL_HTTP_PATH } = await import("./http/main");
    let handle: Awaited<ReturnType<typeof startLocalHttpMcp>>;
    try {
      handle = await startLocalHttpMcp({ port });
    } catch (error) {
      // A swallowed reason here reads as "MCP is broken" when the real cause is usually one stale
      // server still holding the port, so say which port failed and why.
      const reason = (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `port ${port} is already in use. Stop whatever is listening on it, pick another with \`--port N\`, or use the stdio transport with \`maccabi mcp\`.`
        : error instanceof Error && error.message ? error.message : "no reason was reported.";
      process.stderr.write(`Maccabi MCP HTTP transport could not start on http://${LOCAL_HTTP_HOST}:${port}${LOCAL_HTTP_PATH}: ${reason}\n`);
      return 1;
    }
    process.stderr.write(`Maccabi MCP listening at ${handle.url.href}\n`);
    const stop = () => { void handle.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    return await new Promise<number>(() => {});
  } else if (args.length) {
    const hint = args[0] === "--port" ? `--port applies only with --http.\n` : "";
    process.stderr.write(`${hint}${MCP_USAGE}Authenticate separately with \`maccabi login\`. No credentials are accepted here.\n`);
    return 2;
  } else {
    return await awaitStdioShutdown(startLocalMcp());
  }
}
