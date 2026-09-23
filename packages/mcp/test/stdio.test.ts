import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ReauthenticationRequired, type MaccabiSession } from "@maccabi/core";
import { CLI_REAUTHENTICATION_INSTRUCTION, localSessionResolver, RENEWAL_INTERVAL_MS, startLocalMcp, startSessionRenewal } from "../src/stdio";
import { COVERAGE_URI, createMaccabiMcpServer, serialExecutor, type ConnectedReaders, type ReaderOperations, type SessionLease } from "../src/tools";

const repo = new URL("../../../", import.meta.url).pathname;
async function subprocess(file: string, modern = false, extraArgs: string[] = []) {
  const args = file.endsWith(".ts") ? ["--import", "tsx", file, ...extraArgs] : [file, ...extraArgs];
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: repo, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", data => { stderr += data.toString(); });
  const client = new Client({ name: "stdio-synthetic-test", version: "1" }, modern ? { versionNegotiation: { mode: "auto" } } : undefined);
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

describe("official SDK stdio integration", () => {
  test("actual production entry initializes, lists tools and reads coverage without touching the session file or clinical stdout", async () => {
    const h = await subprocess("dist/cli.js", false, ["mcp"]);
    try {
      // Counts the built dist/, so it fails until a rebuild picks up new tools. Guards against
      // accidentally dropping tools from the stdio surface, which registers the login pair too.
      expect((await h.client.listTools()).tools.length).toBe(38);
      expect(JSON.stringify(await h.client.readResource({ uri: COVERAGE_URI }))).toContain("complete historical");
      expect(h.stderr()).toBe("");
    } finally { await h.client.close(); }
  });
  test("synthetic subprocess uses same core library over clean stdio for legacy and modern SDK clients", async () => {
    for (const modern of [false, true]) {
      const h = await subprocess("packages/mcp/test/fixtures/stdio-server.ts", modern);
      try {
        const profile = await h.client.callTool({ name: "maccabi_account", arguments: { section: "profile" } });
        expect((profile as any).structuredContent.data.f_name_hebrew).toBe("דוגמה");
        expect(JSON.stringify(profile)).not.toContain("synthetic-upstream-token");
        expect(JSON.stringify(profile)).not.toContain("123456789");
        const labs = await h.client.callTool({ name: "maccabi_tests", arguments: { year: 2025 } });
        expect((labs as any).structuredContent.data.length).toBe(1);
        expect((labs as any).structuredContent.data[0].request_id).toBe("fixture-request-2025");
        expect((labs as any).structuredContent.source.completeness).toBe("local-filtered-subset");
        expect(h.stderr()).toBe("");
      } finally { await h.client.close(); }
    }
  });
  test("local resolver persists only the loaded owner binding and invalidates through its injected store", async () => {
    let saves = 0; let removes = 0;
    const saved: any = { session: { version: 1, synthetic: true }, owner: { memberId: 123456789, memberIdCode: "0" } };
    const resolver = localSessionResolver({ load: async () => saved, save: async next => { saves++; expect(next.owner).toEqual(saved.owner); }, delete: async () => { removes++; } });
    const lease = await resolver();
    expect(lease?.owner).toEqual(saved.owner);
    await lease?.save(saved.session); await lease?.invalidate();
    expect(saves).toBe(1); expect(removes).toBe(1);
  });
  test("the real entry point shuts down cleanly when the client closes stdin", () => {
    // Before the shutdown fix this exited 13 with Node's "unsettled top-level await" warning on
    // stderr, because the command returned a promise nothing ever resolved.
    const config = mkdtempSync(join(tmpdir(), "maccabi-mcp-stdio-"));
    try {
      const child = spawnSync(process.execPath, ["--import", "tsx", "packages/cli/src/main.ts", "mcp"], {
        cwd: repo, input: "", timeout: 15_000, env: { ...process.env, MACCABI_CONFIG_DIR: config },
      });
      expect(child.stderr.toString()).not.toContain("unsettled top-level await");
      expect(child.stdout.toString()).toBe("");
      expect(child.stderr.toString()).toBe("");
      expect(child.status).toBe(0);
    } finally { rmSync(config, { recursive: true, force: true }); }
  });
  test("credential-style executable arguments are rejected without echoing their values", async () => {
    const child = spawnSync(process.execPath, ["dist/cli.js", "mcp", "--otp", "synthetic-sensitive-value"], { cwd: repo });
    const code = child.status, stdout = child.stdout.toString(), stderr = child.stderr.toString();
    expect(code).toBe(2); expect(stdout).toBe(""); expect(stderr).toContain("No credentials"); expect(stderr).not.toContain("synthetic-sensitive-value");
  });
});

const renewalOwner = { memberId: 123456789, memberIdCode: "0" };
const synthetic = (tag: string) => ({ version: 1, authenticatedAt: tag, cookies: { version: "tough-cookie@6.0.2", storeType: "MemoryCookieStore", rejectPublicSuffixes: true, cookies: [] } }) as unknown as MaccabiSession;
const renewingReaders = (renew: () => Promise<unknown>) => ({ renewSession: renew } as unknown as ReaderOperations);

/**
 * Maccabi kills an idle session long before its absolute cap, and each CLI run is a fresh process.
 * The stdio server is the only long-lived one, so these cover the timer that keeps the session usable.
 */
describe("stdio background session renewal", () => {
  test("a tick renews behind the shared executor and saves the refreshed session", async () => {
    const before = synthetic("before"), after = synthetic("after");
    const order: string[] = [];
    let stored = before, invalidates = 0;
    const exclusive = serialExecutor();
    const renewal = startSessionRenewal({
      intervalMs: 3_600_000, exclusive,
      resolveSession: async (): Promise<SessionLease> => ({ session: stored, owner: renewalOwner, save: async next => { stored = next; order.push("save"); }, invalidate: async () => { invalidates++; } }),
      connect: async (session, owner): Promise<ConnectedReaders> => {
        expect(session).toBe(before); expect(owner).toBe(renewalOwner);
        return { readers: renewingReaders(async () => { order.push("renew"); return { data: { renewed: true } }; }), exportSession: async () => after };
      },
      stderr: () => { throw new Error("a successful renewal must stay off stderr"); },
    });
    // A tool call already inside the executor has to finish before the tick touches the same session.
    let release!: () => void;
    const busy = exclusive(async () => { await new Promise<void>(resolve => { release = resolve; }); order.push("tool"); });
    const ticked = renewal.tick();
    await sleep(1);
    expect(order).toEqual([]);
    release();
    await busy; await ticked;
    expect(order).toEqual(["tool", "renew", "save"]);
    expect(stored).toBe(after);
    expect(invalidates).toBe(0);
    renewal.stop();
  });

  test("no stored session yet is silent and keeps the timer running", async () => {
    let resolved = 0, connects = 0;
    const renewal = startSessionRenewal({
      intervalMs: 1, exclusive: serialExecutor(),
      resolveSession: async () => { resolved++; return null; },
      connect: async () => { connects++; throw new Error("a signed-out member must never be connected"); },
      stderr: () => { throw new Error("being signed out is not a renewal failure"); },
    });
    try { for (let waited = 0; resolved < 3 && waited < 200; waited++) await sleep(5); } finally { renewal.stop(); }
    expect(resolved).toBeGreaterThanOrEqual(3);
    expect(connects).toBe(0);
  });

  test("a failed renewal stops the timer, reports once and never deletes the stored session", async () => {
    for (const failure of [new ReauthenticationRequired(401), new Error("network down")]) {
      let attempts = 0, saves = 0, invalidates = 0;
      const reports: string[] = [];
      const clear = vi.spyOn(globalThis, "clearInterval");
      const renewal = startSessionRenewal({
        intervalMs: 3_600_000, exclusive: serialExecutor(),
        resolveSession: async (): Promise<SessionLease> => ({ session: synthetic("kept"), owner: renewalOwner, save: async () => { saves++; }, invalidate: async () => { invalidates++; } }),
        connect: async () => { attempts++; throw failure; },
        stderr: text => { reports.push(text); },
      });
      try {
        await renewal.tick();
        expect(attempts).toBe(1);
        expect(clear).toHaveBeenCalled(); // The timer is torn down inside the failing tick, not left to retry.
        expect(saves).toBe(0);
        // The member can only replace this credential with a fresh SMS, so the timer must never remove it.
        expect(invalidates).toBe(0);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toContain("left in place");
        expect(reports[0]!.endsWith("\n")).toBe(true);
      } finally { renewal.stop(); clear.mockRestore(); }
    }
  });

  test("the renewal timer never holds the process open and is cleared on stop", async () => {
    const started = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      const renewal = startSessionRenewal({ intervalMs: 3_600_000, exclusive: serialExecutor(), resolveSession: async () => null });
      const timer = started.mock.results.at(-1)!.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      renewal.stop();
      expect(clear).toHaveBeenCalledWith(timer);
      renewal.stop();
      expect(clear).toHaveBeenCalledTimes(1); // Stopping twice, as a failed tick then a close does, is not two clears.
    } finally { started.mockRestore(); clear.mockRestore(); }
  });

  test("the stdio server renews on the 240-second default and stops the timer when it closes", async () => {
    // Well under the shortest idle death observed on the wire, and the same number the CLI keep-alive defaults to.
    expect(RENEWAL_INTERVAL_MS).toBe(240_000);
    const started = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      const handle = startLocalMcp({ resolveSession: async () => null });
      expect(started).toHaveBeenLastCalledWith(expect.any(Function), RENEWAL_INTERVAL_MS);
      const before = clear.mock.calls.length;
      await handle.close();
      expect(clear).toHaveBeenCalledWith(started.mock.results.at(-1)!.value);
      expect(clear.mock.calls.length).toBeGreaterThan(before);
    } finally { started.mockRestore(); clear.mockRestore(); }
  });

  test("the stdio reauthentication guidance names the commands the member actually has to type", async () => {
    for (const literal of ["`maccabi login`", "`maccabi login --id <id>`", "`maccabi login --code <code>`", "`--phone <n>`"]) {
      expect(CLI_REAUTHENTICATION_INSTRUCTION).toContain(literal);
    }
    const lease = await localSessionResolver({ load: async () => ({ session: synthetic("stored"), owner: renewalOwner }), save: async () => {}, delete: async () => {} })();
    expect(lease?.reauthentication?.instruction).toBe(CLI_REAUTHENTICATION_INSTRUCTION);
  });

  /**
   * The defect this covers was observed live: two freshly started servers blocked on their first
   * session tool call, one for ten minutes until it was killed, with no network socket open the whole
   * time. Tool calls, sign-in and this timer all queue on one executor, so any unbounded wait inside
   * it held every later call behind it - and an MCP client has no recourse against a server that
   * simply never answers. Erroring is strictly better than hanging.
   */
  test("a renewal that never settles is abandoned instead of blocking every later tool call", async () => {
    const exclusive = serialExecutor(150);
    const lease: SessionLease = { session: synthetic("stored"), owner: renewalOwner, save: async () => {}, invalidate: async () => {} };
    const reports: string[] = [];
    const renewal = startSessionRenewal({
      intervalMs: 3_600_000, exclusive,
      resolveSession: async () => lease,
      // A stall that neither answers nor fails, which is what a request that never settles looks like.
      connect: () => new Promise<ConnectedReaders>(() => {}),
      stderr: text => { reports.push(text); },
    });
    const ticked = renewal.tick();
    const server = createMaccabiMcpServer({
      resolveSession: async () => lease, runExclusive: exclusive, operationTimeoutMs: 150,
      connect: async (): Promise<ConnectedReaders> => ({
        readers: { getOwnerProfile: () => ({ data: { f_name_hebrew: "דוגמה" }, retrievedAt: "2025-01-01T00:00:00Z", source: { service: "synthetic", operation: "synthetic", completeness: "upstream-response" } }) } as unknown as ReaderOperations,
        exportSession: async () => synthetic("stored"),
      }),
    });
    const client = new Client({ name: "renewal-deadlock", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const answer = await client.callTool({ name: "maccabi_account", arguments: { section: "profile" } });
      expect((answer as any).isError).not.toBe(true);
      expect((answer as any).structuredContent.data.f_name_hebrew).toBe("דוגמה");
    } finally { await client.close(); await server.close(); renewal.stop(); }
    await ticked;
    // The stalled tick is dropped from the queue and reported exactly as a failed renewal is.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("left in place");
  });

  test("a real expiry says the saved session was removed, which is what that path does", async () => {
    // maccabi_capabilities leaves the file alone; the first session call that gets
    // REAUTHENTICATION_REQUIRED deletes it. That is deliberate - the credential is dead upstream and
    // the in-memory jar has already been cleared - so the text says so rather than the member
    // discovering it. The CLI's AUTH_REQUIRED message carries the same sentence.
    expect(CLI_REAUTHENTICATION_INSTRUCTION).toContain("removed from local storage");
    let removals = 0;
    const lease = await localSessionResolver({ load: async () => ({ session: synthetic("dead"), owner: renewalOwner }), save: async () => {}, delete: async () => { removals++; } })();
    await lease?.invalidate();
    expect(removals).toBe(1);
  });
});
