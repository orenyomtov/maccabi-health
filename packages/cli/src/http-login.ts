import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { CredentialStore } from "./store";
import type { LoginAuthDriver, LoginConnected } from "./login";
import type { MaccabiSession, OwnerIdentity } from "@maccabi/core";
import { startQuickTunnel, TunnelError, type TunnelDependencies } from "./tunnel";

export const HTTP_LOGIN_TTL_MS = 10 * 60 * 1000;
/** Parent wait for the child to print a URL; covers a cold cloudflared download. */
export const BACKGROUND_URL_WAIT_MS = 3 * 60 * 1000;

export interface HttpLoginResult {
  status: "browser-login";
  url: string;
  expiresInSeconds: number;
  mode: "foreground" | "background";
}

export interface HttpLoginDependencies {
  env: NodeJS.ProcessEnv;
  store: CredentialStore;
  createAuth(): LoginAuthDriver;
  connect(session: MaccabiSession, expectedOwner?: OwnerIdentity): Promise<LoginConnected>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Detached child for the default background server. Tests replace this. */
  spawnBackground?(argv: string[]): ChildProcess;
  /** Executable path for the background child. Defaults to process.argv[0]/process.argv[1]. */
  execPath?: string;
  scriptPath?: string;
  tunnel?: Partial<TunnelDependencies>;
  /** Test seam: start the browser login server without importing the MCP package. */
  startServer?(options: {
    store: CredentialStore;
    createAuth: () => LoginAuthDriver;
    connect: HttpLoginDependencies["connect"];
  }): Promise<{
    url: URL;
    signedIn: Promise<void>;
    close(): Promise<void>;
  }>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

async function defaultStartServer(options: {
  store: CredentialStore;
  createAuth: () => LoginAuthDriver;
  connect: HttpLoginDependencies["connect"];
}) {
  const { startCliBrowserLogin } = await import("../../mcp/src/http/cli-login");
  return startCliBrowserLogin({
    store: options.store,
    createAuth: options.createAuth,
    connect: options.connect,
  });
}

function printWaiting(deps: HttpLoginDependencies, url: string, mode: "foreground" | "background"): HttpLoginResult {
  const result: HttpLoginResult = {
    status: "browser-login", url, expiresInSeconds: Math.round(HTTP_LOGIN_TTL_MS / 1000), mode,
  };
  deps.stdout(JSON.stringify(result, null, 2) + "\n");
  return result;
}

/**
 * Foreground browser login: start the local server (and optional tunnel), print the URL, wait until
 * the CLI session file is written or ten minutes pass.
 */
export async function runHttpLogin(deps: HttpLoginDependencies, options: { tunnel: boolean }): Promise<number> {
  const startServer = deps.startServer ?? defaultStartServer;
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => sleep(ms));
  let tunnel: { url: string; close(): void } | undefined;
  const handle = await startServer({
    store: deps.store,
    createAuth: deps.createAuth,
    connect: deps.connect,
  });
  try {
    let publicUrl = handle.url.href;
    if (options.tunnel) {
      try {
        tunnel = await startQuickTunnel(handle.url.href, { env: deps.env, ...deps.tunnel });
        publicUrl = tunnel.url;
      } catch (error) {
        const message = error instanceof TunnelError ? error.message : "Could not start the Cloudflare tunnel.";
        deps.stderr(JSON.stringify({ error: { code: "TUNNEL_FAILED", message, exitCode: 1 } }) + "\n");
        return 1;
      }
    }
    printWaiting(deps, publicUrl, "foreground");
    const deadline = now() + HTTP_LOGIN_TTL_MS;
    while (now() < deadline) {
      const remaining = deadline - now();
      const winner = await Promise.race([
        handle.signedIn.then(() => "signed-in" as const),
        wait(Math.min(500, remaining)).then(() => "tick" as const),
      ]);
      if (winner === "signed-in") return 0;
      if (await deps.store.load()) return 0;
    }
    deps.stderr(JSON.stringify({ error: { code: "BROWSER_LOGIN_TIMEOUT", message: "No browser sign-in finished within ten minutes.", exitCode: 1 } }) + "\n");
    return 1;
  } finally {
    tunnel?.close();
    await handle.close().catch(() => undefined);
  }
}

/**
 * Spawn a detached child that runs the same login in the foreground (`--no-background`), read its
 * URL JSON from stdout, print it, and return so the parent shell command completes.
 */
export async function runHttpLoginBackground(
  deps: HttpLoginDependencies,
  argv: string[],
): Promise<number> {
  const execPath = deps.execPath ?? process.execPath;
  const script = deps.scriptPath ?? process.argv[1];
  if (!script) {
    deps.stderr(JSON.stringify({ error: { code: "BACKGROUND_LOGIN_FAILED", message: "Cannot locate the maccabi-health executable to start the browser login.", exitCode: 1 } }) + "\n");
    return 1;
  }
  const childArgv = [...argv.filter(arg => arg !== "--no-background"), "--no-background"];
  const child = deps.spawnBackground
    ? deps.spawnBackground([script, ...childArgv])
    : spawn(execPath, [script, ...childArgv], {
      detached: true, stdio: ["ignore", "pipe", "pipe"], env: deps.env, windowsHide: true,
    });
  try {
    const url = await readBrowserLoginUrl(child, BACKGROUND_URL_WAIT_MS);
    printWaiting(deps, url, "background");
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    return 0;
  } catch (error) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    const message = error instanceof Error ? error.message : "The background browser login did not start.";
    deps.stderr(JSON.stringify({ error: { code: "BACKGROUND_LOGIN_FAILED", message, exitCode: 1 } }) + "\n");
    return 1;
  }
}

/**
 * The child prints pretty-printed JSON (`JSON.stringify(..., null, 2)`), so the URL may span many
 * lines. Parse the whole stdout buffer. Errors from the child are one-line JSON on stderr.
 */
export function takeBrowserLoginUrl(stdout: string, stderr: string): { url?: string; error?: string } {
  const out = stdout.trim();
  if (out) {
    try {
      const parsed = JSON.parse(out) as { url?: string };
      if (typeof parsed.url === "string" && parsed.url) return { url: parsed.url };
    } catch { /* incomplete pretty-printed object */ }
  }
  const err = stderr.trim();
  if (err) {
    for (const candidate of [err, ...err.split(/\r?\n/).map(line => line.trim()).filter(Boolean)]) {
      if (!candidate.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(candidate) as { error?: { message?: string } };
        if (parsed.error?.message) return { error: parsed.error.message };
      } catch { /* incomplete */ }
    }
  }
  return {};
}

function readBrowserLoginUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    let settled = false;
    const timer = setTimeout(() => fail(new Error("Timed out waiting for the browser login URL.")), timeoutMs);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const consider = (): void => {
      const taken = takeBrowserLoginUrl(stdout, stderr);
      if (taken.url) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(taken.url);
        return;
      }
      if (taken.error) fail(new Error(taken.error));
    };
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += String(chunk); consider(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); consider(); });
    child.once("error", error => fail(error instanceof Error ? error : new Error(String(error))));
    child.once("exit", (code, signal) => {
      if (settled) return;
      consider();
      if (settled) return;
      fail(new Error(signal ? `Browser login exited on ${signal}.` : `Browser login exited with code ${code ?? "unknown"}.`));
    });
  });
}
