import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { MaccabiSession, PendingLogin } from "@maccabi/core";
import type { LoginAuthDriver, LoginDependencies } from "../src/login";
import { runCli } from "../src/cli";
import { HTTP_LOGIN_TTL_MS, takeBrowserLoginUrl } from "../src/http-login";
import { ensureCloudflared, extractCloudflaredTarball, parseTunnelUrl, releaseAssetFor } from "../src/tunnel";
import { FileSessionStore } from "../src/store";
import { startCliBrowserLogin } from "../../mcp/src/http/cli-login";

const execFileAsync = promisify(execFile);

const session: MaccabiSession = {
  version: 1, authenticatedAt: "2026-01-01T00:00:00.000Z",
  cookies: { version: "tough-cookie@6.0.2", storeType: "MemoryCookieStore", rejectPublicSuffixes: true, cookies: [] },
};
const owner = { memberId: 12345678, memberIdCode: "0" };
const OTP = "123456";
const MEMBER = "012345678";
const PHONES = [
  { index: 0, label: "Phone ending 12", display: "ending 12", smsAvailable: true },
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function fakeUpstream() {
  const createAuth = (): LoginAuthDriver => {
    let memberId = 0;
    return {
      async beginLogin(id) { memberId = Number(id); return { id: `challenge-${id}`, phones: PHONES.map(phone => ({ ...phone })) }; },
      async requestOtp() {},
      async completeLogin(_id, otp) {
        if (otp !== OTP) throw new Error("bad otp");
        return session;
      },
      async exportPending(): Promise<PendingLogin> {
        return {
          version: 1, id: `challenge-${memberId}`, memberId, senderJwt: "synthetic.sender.jwt", validatorJwt: "synthetic.validator.jwt",
          phones: PHONES.map(phone => ({ ...phone })), expiresAt: Date.now() + 600_000, cookies: session.cookies,
        };
      },
      restorePending(pending) { memberId = pending.memberId; },
      async cancelLogin() {},
    };
  };
  const connect: LoginDependencies["connect"] = async (value, expectedOwner) => ({
    readers: { currentOwner: { memberId: expectedOwner?.memberId ?? 0, memberIdCode: "0" } },
    exportSession: async () => value,
  });
  return { createAuth, connect };
}

function hidden(html: string, name: string): string {
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
}
function cookieOf(response: Response): string {
  const header = response.headers.getSetCookie()[0] ?? response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

function unusedConnect() {
  return {
    createAuth: (): LoginAuthDriver => ({
      beginLogin: async () => ({ id: "", phones: [] }), requestOtp: async () => {}, completeLogin: async () => session,
      exportPending: async () => ({ version: 1 as const, id: "", memberId: 0, senderJwt: "", phones: [], expiresAt: 0, cookies: session.cookies }),
      restorePending: () => {}, cancelLogin: async () => {},
    }),
    connect: (async () => ({ readers: { currentOwner: owner }, exportSession: async () => session })) as never,
  };
}

describe("login --http flags", () => {
  test("--no-tunnel and --no-background without --http are usage errors", async () => {
    for (const argv of [["login", "--no-tunnel", "--no-input"], ["login", "--no-background", "--no-input"], ["login", "--no-tunnel", "--no-background", "--no-input"]]) {
      let error = "";
      const code = await runCli(argv, {
        env: {}, store: { load: async () => null, save: async () => {}, delete: async () => {} },
        pending: { load: async () => null, save: async () => {}, delete: async () => {} },
        isInteractive: () => false, prompt: async () => "", ...unusedConnect(),
        stdout: () => {}, stderr: text => { error += text; },
        startKeepAlive: async () => {}, stopKeepAlive: async () => {}, savePdf: async () => {},
      });
      expect(code).toBe(2);
      expect(JSON.parse(error).error.code).toBe("INVALID_USAGE");
      expect(JSON.parse(error).error.message).toMatch(/needs --http/);
    }
  });

  test("background parent parses pretty-printed child JSON, unrefs, and does not kill", async () => {
    let output = "", error = "";
    let unrefCalled = false;
    let killCalled = false;
    const childStdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout: childStdout,
      stderr: new PassThrough(),
      unref() { unrefCalled = true; },
      kill() { killCalled = true; },
    });
    // Exact shape `printWaiting` emits: indented JSON, not one line.
    const childPayload = JSON.stringify({
      status: "browser-login",
      url: "https://demo-words.trycloudflare.com",
      expiresInSeconds: Math.round(HTTP_LOGIN_TTL_MS / 1000),
      mode: "foreground",
    }, null, 2) + "\n";
    expect(childPayload).toContain("\n");
    expect(takeBrowserLoginUrl(childPayload, "")).toEqual({ url: "https://demo-words.trycloudflare.com" });
    let childArgv: string[] = [];
    const codePromise = runCli(["login", "--http"], {
      env: {}, store: { load: async () => null, save: async () => {}, delete: async () => {} },
      pending: { load: async () => null, save: async () => {}, delete: async () => {} },
      isInteractive: () => false, prompt: async () => "", ...unusedConnect(),
      stdout: text => { output += text; }, stderr: text => { error += text; },
      startKeepAlive: async () => {}, stopKeepAlive: async () => {}, savePdf: async () => {},
      httpLogin: {
        spawnBackground: argv => {
          childArgv = argv;
          // Write in chunks the way a pipe actually delivers pretty-printed JSON.
          queueMicrotask(() => {
            const midpoint = childPayload.indexOf("\n") + 1;
            childStdout.write(childPayload.slice(0, midpoint));
            childStdout.write(childPayload.slice(midpoint));
          });
          return child as never;
        },
      },
    });
    const code = await codePromise;
    expect(code).toBe(0);
    expect(error).toBe("");
    expect(JSON.parse(output)).toMatchObject({
      status: "browser-login",
      url: "https://demo-words.trycloudflare.com",
      mode: "background",
      expiresInSeconds: 600,
    });
    expect(unrefCalled).toBe(true);
    expect(killCalled).toBe(false);
    expect(childArgv.slice(1)).toEqual(["login", "--http", "--no-background"]);
  });

  test("background parent surfaces a one-line error JSON from the child stderr", async () => {
    let error = "";
    let killCalled = false;
    const childStderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: childStderr,
      unref() {},
      kill() { killCalled = true; },
    });
    const code = await runCli(["login", "--http"], {
      env: {}, store: { load: async () => null, save: async () => {}, delete: async () => {} },
      pending: { load: async () => null, save: async () => {}, delete: async () => {} },
      isInteractive: () => false, prompt: async () => "", ...unusedConnect(),
      stdout: () => {}, stderr: text => { error += text; },
      startKeepAlive: async () => {}, stopKeepAlive: async () => {}, savePdf: async () => {},
      httpLogin: {
        spawnBackground: () => {
          queueMicrotask(() => {
            childStderr.write(`${JSON.stringify({ error: { code: "TUNNEL_FAILED", message: "Could not download cloudflared.", exitCode: 1 } })}\n`);
            child.emit("exit", 1, null);
          });
          return child as never;
        },
      },
    });
    expect(code).toBe(1);
    expect(killCalled).toBe(true);
    expect(JSON.parse(error).error).toMatchObject({ code: "BACKGROUND_LOGIN_FAILED", message: "Could not download cloudflared." });
  });
});

describe("cloudflared assets", () => {
  test("extracts the trycloudflare.com URL from a fixture of cloudflared output", () => {
    const fixture = `
2026-03-27T12:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to expose a local development environment to the Internet. Your temporary tunnel will expire in 24 hours. Please keep the tunnel running to keep the site available.
2026-03-27T12:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-03-27T12:00:02Z INF +--------------------------------------------------------------------------------------------+
2026-03-27T12:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-03-27T12:00:02Z INF |  https://random-words-here.trycloudflare.com                                               |
2026-03-27T12:00:02Z INF +--------------------------------------------------------------------------------------------+
2026-03-27T12:00:03Z INF Cannot determine default configuration path. No file [config.yml config.yaml] in [~/.cloudflared ~/.cloudflare-warp ~/cloudflare-warp]
`;
    expect(parseTunnelUrl(fixture)).toBe("https://random-words-here.trycloudflare.com");
    expect(parseTunnelUrl("no tunnel here")).toBeNull();
  });

  test("release asset names match the GitHub listing (darwin tarball, linux/windows binary)", () => {
    expect(releaseAssetFor("darwin", "arm64")).toEqual({ name: "cloudflared-darwin-arm64.tgz", executable: "cloudflared", packed: true });
    expect(releaseAssetFor("darwin", "x64")).toEqual({ name: "cloudflared-darwin-amd64.tgz", executable: "cloudflared", packed: true });
    expect(releaseAssetFor("linux", "x64")).toEqual({ name: "cloudflared-linux-amd64", executable: "cloudflared", packed: false });
    expect(releaseAssetFor("linux", "arm64")).toEqual({ name: "cloudflared-linux-arm64", executable: "cloudflared", packed: false });
    expect(releaseAssetFor("win32", "x64")).toEqual({ name: "cloudflared-windows-amd64.exe", executable: "cloudflared.exe", packed: false });
  });

  test("extracts the cloudflared binary from a tiny darwin tarball fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maccabi-tgz-"));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    await writeFile(join(dir, "cloudflared"), "#!/bin/sh\necho fixture\n", { mode: 0o755 });
    const tgz = join(dir, "cloudflared-darwin-arm64.tgz");
    await execFileAsync("tar", ["-czf", tgz, "-C", dir, "cloudflared"]);
    const out = join(dir, "out");
    const binary = await extractCloudflaredTarball(tgz, out);
    expect(binary).toBe(join(out, "cloudflared"));
    expect(await readFile(binary, "utf8")).toContain("echo fixture");
  });

  test("darwin ensureCloudflared downloads a tarball and caches the executable, not the archive", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "maccabi-cf-cache-"));
    cleanups.push(async () => { await rm(configDir, { recursive: true, force: true }); });
    const staging = await mkdtemp(join(tmpdir(), "maccabi-cf-stage-"));
    cleanups.push(async () => { await rm(staging, { recursive: true, force: true }); });
    await writeFile(join(staging, "cloudflared"), "#!/bin/sh\necho cached\n", { mode: 0o755 });
    const tgz = join(staging, "asset.tgz");
    await execFileAsync("tar", ["-czf", tgz, "-C", staging, "cloudflared"]);
    const bytes = await readFile(tgz);
    let requested = "";
    const path = await ensureCloudflared({ MACCABI_CONFIG_DIR: configDir }, {
      platform: "darwin", arch: "arm64",
      fetch: async (url) => {
        requested = String(url);
        return new Response(bytes, { status: 200 });
      },
    });
    expect(requested).toContain("cloudflared-darwin-arm64.tgz");
    expect(path).toBe(join(configDir, "cache", "cloudflared", "cloudflared"));
    expect(await readFile(path, "utf8")).toContain("echo cached");
    await expect(access(join(configDir, "cache", "cloudflared", "cloudflared-darwin-arm64.tgz"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("CLI browser login session file", () => {
  test("writes the CLI session file and not an MCP HTTP sessions/ credential", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "maccabi-cli-http-"));
    cleanups.push(async () => { await rm(configDir, { recursive: true, force: true }); });
    const store = new FileSessionStore(join(configDir, "session.json"));
    const upstream = fakeUpstream();
    const handle = await startCliBrowserLogin({ store, createAuth: upstream.createAuth, connect: upstream.connect });
    cleanups.push(() => handle.close());

    const start = await fetch(handle.url);
    const html = await start.text();
    const cookie = cookieOf(start);
    const sessionId = hidden(html, "session");
    const csrf = hidden(html, "csrf");
    expect(sessionId).toBeTruthy();
    expect(csrf).toBeTruthy();

    const idStep = await fetch(new URL("/authorize", handle.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ session: sessionId, csrf, step: "id", id: MEMBER }),
      redirect: "manual",
    });
    const otpHtml = await idStep.text();
    expect(otpHtml).toContain("Enter the code");
    const otpCsrf = hidden(otpHtml, "csrf") || csrf;

    const otpStep = await fetch(new URL("/authorize", handle.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ session: sessionId, csrf: otpCsrf, step: "otp", code: OTP }),
      redirect: "manual",
    });
    expect(await otpStep.text()).toContain("Signed in");
    await handle.signedIn;

    const saved = await store.load();
    expect(saved).toMatchObject({ owner: { memberId: Number(MEMBER), memberIdCode: "0" }, session });
    await expect(readdir(join(configDir, "sessions")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    })).resolves.toEqual([]);
  });
});
