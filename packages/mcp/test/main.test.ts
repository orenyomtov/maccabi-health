import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LOCAL_HTTP_PORT, PORT_VARIABLE, resolveHttpPort } from "../src/port";
import { awaitStdioShutdown, MCP_USAGE, runMcp } from "../src/main";

/**
 * The HTTP half is stubbed here on purpose. Every assertion below is about the command's own
 * argument handling, and loading the real module would open the OAuth store in the member's real
 * config directory and bind a socket for tests that only need to know which port was asked for.
 */
const upstream = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../src/http/main", () => ({
  LOCAL_HTTP_HOST: "127.0.0.1",
  LOCAL_HTTP_PATH: "/mcp",
  LOCAL_HTTP_PORT: 8765,
  startLocalHttpMcp: upstream.start,
}));

function addressInUse(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("listen EADDRINUSE");
  error.code = "EADDRINUSE";
  return error;
}

/** runMcp writes straight to the process streams, so they are the only place to read its output. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { out.push(String(chunk)); return true; });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { err.push(String(chunk)); return true; });
  return {
    out: () => out.join(""),
    err: () => err.join(""),
    restore: () => { stdout.mockRestore(); stderr.mockRestore(); },
  };
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const streams = capture();
  try {
    const code = await runMcp(args);
    return { code, out: streams.out(), err: streams.err() };
  } finally { streams.restore(); }
}

afterEach(() => {
  upstream.start.mockReset();
  delete process.env[PORT_VARIABLE];
});

describe("choosing the local Streamable HTTP port", () => {
  test("the default is unchanged when neither the flag nor the variable is set", () => {
    expect(LOCAL_HTTP_PORT).toBe(8765);
    expect(resolveHttpPort(undefined, {})).toEqual({ port: 8765 });
  });

  test("the flag wins over the variable, and an empty variable is ignored", () => {
    expect(resolveHttpPort("9000", { [PORT_VARIABLE]: "9100" })).toEqual({ port: 9000 });
    expect(resolveHttpPort(undefined, { [PORT_VARIABLE]: "9100" })).toEqual({ port: 9100 });
    expect(resolveHttpPort(undefined, { [PORT_VARIABLE]: "" })).toEqual({ port: LOCAL_HTTP_PORT });
  });

  test("a bogus value is refused by name instead of binding something surprising", () => {
    for (const bad of ["abc", "80.5", "-1", " 9000", "9000 ", "", "0", "65536", "99999999999"]) {
      const resolved = resolveHttpPort(bad, {});
      expect(resolved, bad).not.toHaveProperty("port");
      expect((resolved as { error: string }).error).toContain("--port");
      expect((resolved as { error: string }).error).toContain("1 and 65535");
    }
    expect(resolveHttpPort(undefined, { [PORT_VARIABLE]: "nope" })).toEqual({ error: expect.stringContaining(PORT_VARIABLE) });
  });

  test("the resolved port reaches the server and the address-in-use message", async () => {
    upstream.start.mockRejectedValue(addressInUse());
    const result = await run(["--http", "--port", "9123"]);
    expect(result.code).toBe(1);
    expect(upstream.start).toHaveBeenCalledWith({ port: 9123 });
    expect(result.err).toContain("http://127.0.0.1:9123/mcp");
    expect(result.err).toContain("port 9123 is already in use");
    expect(result.err).toContain("--port N");
    expect(result.err).not.toContain("8765");
    expect(result.out).toBe("");
  });

  test("the variable reaches the server when the flag is absent", async () => {
    upstream.start.mockRejectedValue(addressInUse());
    process.env[PORT_VARIABLE] = "9124";
    expect((await run(["--http"])).code).toBe(1);
    expect(upstream.start).toHaveBeenCalledWith({ port: 9124 });
  });

  test("an out-of-range or non-numeric port stops before anything is started", async () => {
    for (const bad of ["70000", "0", "abc"]) {
      const result = await run(["--http", "--port", bad]);
      expect(result.code, bad).toBe(2);
      expect(result.err).toContain("1 and 65535");
      expect(result.err).toContain(bad);
      expect(upstream.start).not.toHaveBeenCalled();
    }
  });

  test("a malformed --http invocation is a usage error, not a default-port start", async () => {
    for (const args of [["--http", "--port"], ["--http", "--port", "--json"], ["--http", "--json"], ["--http", "--port", "9000", "extra"]]) {
      const result = await run(args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.err).toBe(MCP_USAGE);
      expect(upstream.start).not.toHaveBeenCalled();
    }
  });

  test("--port without --http says so rather than silently starting stdio", async () => {
    const result = await run(["--port", "9000"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--port applies only with --http.");
    expect(result.err).toContain("No credentials are accepted here.");
  });

  test("help documents the flag, the variable and the default", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(MCP_USAGE);
    expect(result.out).toContain("--port N");
    expect(result.out).toContain(String(LOCAL_HTTP_PORT));
    expect(result.out).toContain(PORT_VARIABLE);
    expect(result.err).toBe("");
  });

  test("credential-shaped arguments are still refused without echoing their values", async () => {
    const result = await run(["--otp", "synthetic-sensitive-value"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("No credentials");
    expect(result.err).not.toContain("synthetic-sensitive-value");
  });
});

describe("stdio shutdown", () => {
  test("end of input closes the server and settles with an exit code", async () => {
    const input = new EventEmitter();
    let closes = 0;
    const settled = awaitStdioShutdown({ close: async () => { closes++; } }, input);
    input.emit("end");
    input.emit("close");
    expect(await settled).toBe(0);
    expect(closes).toBe(1);
  });

  test("a failed close is reported as a failing exit code rather than a hang", async () => {
    const input = new EventEmitter();
    const settled = awaitStdioShutdown({ close: async () => { throw new Error("synthetic close failure"); } }, input);
    input.emit("close");
    expect(await settled).toBe(1);
  });

  test("signal handlers are registered while running and removed once it settles", async () => {
    const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
    const input = new EventEmitter();
    const settled = awaitStdioShutdown({ close: async () => undefined }, input);
    expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);
    input.emit("end");
    await settled;
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });
});
