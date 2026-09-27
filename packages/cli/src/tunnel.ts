import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, rename, rm } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { configDirectory } from "./store";

const execFileAsync = promisify(execFile);

/** Official quick-tunnel hostname cloudflared prints when `--url` succeeds. */
export const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class TunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelError";
  }
}

export function parseTunnelUrl(output: string): string | null {
  const match = TUNNEL_URL_PATTERN.exec(output);
  return match ? match[0]!.toLowerCase().replace(/^http:/, "https:") : null;
}

export interface ReleaseAsset {
  /** Filename under the GitHub release (darwin ships a .tgz; linux/windows ship a raw binary). */
  name: string;
  executable: string;
  /** True when `name` is a gzipped tar that must be unpacked to reach `executable`. */
  packed: boolean;
}

/** Asset names match the current cloudflare/cloudflared GitHub release listing. */
export function releaseAssetFor(os: NodeJS.Platform | string, cpu: string): ReleaseAsset {
  if (os === "darwin" && cpu === "arm64") return { name: "cloudflared-darwin-arm64.tgz", executable: "cloudflared", packed: true };
  if (os === "darwin" && cpu === "x64") return { name: "cloudflared-darwin-amd64.tgz", executable: "cloudflared", packed: true };
  if (os === "linux" && cpu === "arm64") return { name: "cloudflared-linux-arm64", executable: "cloudflared", packed: false };
  if (os === "linux" && cpu === "x64") return { name: "cloudflared-linux-amd64", executable: "cloudflared", packed: false };
  if (os === "win32" && cpu === "x64") return { name: "cloudflared-windows-amd64.exe", executable: "cloudflared.exe", packed: false };
  throw new TunnelError(`No cloudflared binary is listed for ${os}/${cpu}.`);
}

function cacheDirectory(env: NodeJS.ProcessEnv): string {
  return join(configDirectory(env), "cache", "cloudflared");
}

/** Unpack a darwin release tarball; returns the path to the `cloudflared` binary inside destDir. */
export async function extractCloudflaredTarball(archivePath: string, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", destDir]);
  } catch {
    throw new TunnelError("Could not extract the cloudflared archive.");
  }
  const binary = join(destDir, "cloudflared");
  try {
    await access(binary);
  } catch {
    throw new TunnelError("The cloudflared archive did not contain a cloudflared binary.");
  }
  if (platform() !== "win32") await chmod(binary, 0o700);
  return binary;
}

export interface EnsureCloudflaredOptions {
  fetch?: typeof fetch;
  platform?: NodeJS.Platform | string;
  arch?: string;
}

/**
 * Downloads cloudflared on first use into the CLI cache dir. Darwin assets are `.tgz` and are
 * unpacked; linux/windows assets are the raw executable. The cache always holds the binary.
 */
export async function ensureCloudflared(env: NodeJS.ProcessEnv, options: EnsureCloudflaredOptions = {}): Promise<string> {
  const asset = releaseAssetFor(options.platform ?? platform(), options.arch ?? arch());
  const directory = cacheDirectory(env);
  const path = join(directory, asset.executable);
  try {
    await access(path);
    return path;
  } catch { /* download on first use */ }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.name}`;
  const downloadPath = `${path}.${process.pid}.download`;
  const extractDir = `${path}.${process.pid}.extract`;
  try {
    const response = await (options.fetch ?? fetch)(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new TunnelError(`Could not download cloudflared (HTTP ${response.status}).`);
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(downloadPath, { mode: 0o700 }));
    if (asset.packed) {
      const extracted = await extractCloudflaredTarball(downloadPath, extractDir);
      await rename(extracted, path);
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
      await rm(downloadPath, { force: true }).catch(() => {});
    } else {
      if (platform() !== "win32") await chmod(downloadPath, 0o700);
      await rename(downloadPath, path);
    }
    return path;
  } catch (error) {
    await rm(downloadPath, { force: true }).catch(() => {});
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof TunnelError) throw error;
    throw new TunnelError("Could not download cloudflared.");
  }
}

export interface QuickTunnel {
  url: string;
  close(): void;
}

export interface TunnelChild {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface TunnelDependencies {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform | string;
  arch?: string;
  spawnCloudflared?: (binary: string, localUrl: string) => TunnelChild;
  /** How long to wait for the trycloudflare.com URL before failing. */
  urlTimeoutMs?: number;
}

function defaultSpawn(binary: string, localUrl: string): TunnelChild {
  return spawn(binary, ["tunnel", "--url", localUrl, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
}

/**
 * Downloads cloudflared on first use into the CLI cache dir, then runs a quick tunnel to the local
 * login server. The returned URL is the https://*.trycloudflare.com address parsed from its output.
 */
export async function startQuickTunnel(localUrl: string, deps: TunnelDependencies): Promise<QuickTunnel> {
  const binary = await ensureCloudflared(deps.env, { fetch: deps.fetch, platform: deps.platform, arch: deps.arch });
  const child = (deps.spawnCloudflared ?? defaultSpawn)(binary, localUrl);
  const timeoutMs = deps.urlTimeoutMs ?? 30_000;
  let buffer = "";
  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new TunnelError("Timed out waiting for the Cloudflare tunnel URL.")), timeoutMs);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const found = parseTunnelUrl(buffer);
      if (!found || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(found);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", error => fail(new TunnelError(error.message || "cloudflared failed to start.")));
    child.once("exit", (code, signal) => {
      if (settled) return;
      fail(new TunnelError(signal ? `cloudflared exited on ${signal}.` : `cloudflared exited with code ${code ?? "unknown"}.`));
    });
  });
  return {
    url,
    close() {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    },
  };
}
