import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MaccabiError, type MaccabiSession, type OwnerIdentity, type PendingLogin } from "@maccabi/core";

export interface SavedLogin { session: MaccabiSession; owner: OwnerIdentity }
export interface CredentialStore {
  load(): Promise<SavedLogin | null>;
  save(login: SavedLogin): Promise<void>;
  delete(): Promise<void>;
}
export interface PendingLoginStore {
  load(): Promise<PendingLogin | null>;
  save(pending: PendingLogin): Promise<void>;
  delete(): Promise<void>;
}
/** Local protected storage, not upstream: it carries its own code so callers never report it as a failed Maccabi read. */
export class SessionStoreError extends MaccabiError {
  constructor(message = "The saved session file could not be read or written. Check the permissions of the maccabi config directory and retry.") { super("SESSION_STORE_UNAVAILABLE", message); }
}
export function configDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.MACCABI_CONFIG_DIR) return environment.MACCABI_CONFIG_DIR;
  if (environment.XDG_CONFIG_HOME) return join(environment.XDG_CONFIG_HOME, "maccabi-mcp");
  if (process.platform === "win32" && environment.APPDATA) return join(environment.APPDATA, "maccabi-mcp");
  return join(homedir(), ".config", "maccabi-mcp");
}
export async function readProtected(path: string): Promise<string | null> {
  try {
    const file = await open(path, "r");
    try {
      if ((await file.stat()).mode & 0o077) process.stderr.write(`Warning: ${path} is readable by other users; run chmod 600 on it.\n`);
      return await file.readFile("utf8");
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; // Signed out is not a failure.
    throw new SessionStoreError();
  }
}
export async function writeProtected(path: string, value: unknown): Promise<void> {
  // Unique per call, not per process: two concurrent writes that shared a temporary path would
  // collide on the exclusive create, and the loser's cleanup would delete the winner's file before
  // its rename, leaving no session at all.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Create the replacement with its final mode, then swap it in, so no truncated or readable file is ever observable.
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch {
    // Only this call's own temporary file; a failed write never touches the final path or another write's file.
    await rm(temporary, { force: true }).catch(() => {});
    throw new SessionStoreError();
  }
}
export async function removeProtected(path: string): Promise<void> {
  try { await rm(path, { force: true }); }
  catch { throw new SessionStoreError(); }
}

/** One owner-readable JSON file; no other file in the config directory is read or written. */
export class FileSessionStore implements CredentialStore {
  constructor(private readonly path: string = join(configDirectory(), "session.json")) {}
  async load(): Promise<SavedLogin | null> {
    const text = await readProtected(this.path);
    if (text === null) return null;
    try {
      const saved = JSON.parse(text) as SavedLogin;
      if (saved.session?.version !== 1 || !Array.isArray(saved.session.cookies?.cookies) ||
        typeof saved.session.authenticatedAt !== "string" || !Number.isSafeInteger(saved.owner?.memberId) ||
        typeof saved.owner.memberIdCode !== "string") throw new Error("Invalid session");
      return saved;
    } catch { throw new SessionStoreError(`${this.path} is not a usable saved session. Run maccabi logout, then log in again.`); }
  }
  async save(login: SavedLogin): Promise<void> { await writeProtected(this.path, login); }
  async delete(): Promise<void> { await removeProtected(this.path); }
}

/** A second protected file holding one half-finished challenge: bearer tokens plus its mid-login cookie jar. */
export class FilePendingLoginStore implements PendingLoginStore {
  constructor(
    private readonly path: string = join(configDirectory(), "pending-login.json"),
    private readonly now: () => number = Date.now,
  ) {}
  async load(): Promise<PendingLogin | null> {
    const text = await readProtected(this.path);
    if (text === null) return null;
    let pending: PendingLogin;
    try {
      pending = JSON.parse(text) as PendingLogin;
      if (pending.version !== 1 || typeof pending.id !== "string" || typeof pending.senderJwt !== "string" ||
        !Number.isSafeInteger(pending.memberId) || !Array.isArray(pending.phones) ||
        !Number.isFinite(pending.expiresAt) || !Array.isArray(pending.cookies?.cookies)) throw new Error("Invalid pending login");
    } catch { throw new SessionStoreError(`${this.path} is not a usable pending login. Run maccabi logout, then log in again.`); }
    // The challenge carries its own ten-minute deadline; past it the file is gone, not resumable.
    if (this.now() >= pending.expiresAt) { await this.delete(); return null; }
    return pending;
  }
  async save(pending: PendingLogin): Promise<void> { await writeProtected(this.path, pending); }
  async delete(): Promise<void> { await removeProtected(this.path); }
}
