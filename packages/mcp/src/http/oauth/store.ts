import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { readProtected, writeProtected } from "@maccabi/cli/store";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
/** `/register` is unauthenticated by design, so the table needs a ceiling and a way to forget clients that stopped coming back. */
export const MAX_CLIENTS = 64;
export const CLIENT_IDLE_MS = 90 * 24 * 60 * 60 * 1000;

export interface StoredClient { clientId: string; redirectUris: string[]; clientName?: string; issuedAt: number; lastUsedAt: number }
interface StoredCode { clientId: string; redirectUri: string; resource: string; codeChallenge: string; subject: string; scope: string; expiresAt: number }
interface StoredAccess { clientId: string; subject: string; resource: string; scope: string; expiresAt: number }
interface StoredRefresh { clientId: string; subject: string; resource: string; scope: string; expiresAt: number; consumed: boolean }
export interface IssuedTokens { accessToken: string; refreshToken: string; expiresIn: number; scope: string }
export interface RedeemedCode { subject: string; resource: string; scope: string }

interface StoredRecord {
  version: 1;
  clients: StoredClient[];
  codes: [string, StoredCode][];
  access: [string, StoredAccess][];
  refresh: [string, StoredRefresh][];
}

const newSecret = () => randomBytes(32).toString("base64url");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
/** Constant-time over the verifier comparison; everything else is a hash-keyed map lookup, which leaks nothing useful. */
function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8"), right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
function invalidGrant(message: string): OAuthError { return new OAuthError(OAuthErrorCode.InvalidGrant, message); }

/**
 * Clients, authorization codes and tokens for the loopback Authorization Server. In-memory maps are
 * the source of truth; the file is a write-through mirror so a restart does not cost the member a new
 * SMS. Only the SHA-256 of every token is ever stored.
 */
export class OAuthStore {
  #clients = new Map<string, StoredClient>();
  #codes = new Map<string, StoredCode>();
  #access = new Map<string, StoredAccess>();
  #refresh = new Map<string, StoredRefresh>();
  #writes: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, private readonly now: () => number) {}

  static async open(path: string, now: () => number = Date.now): Promise<OAuthStore> {
    const store = new OAuthStore(path, now);
    const text = await readProtected(path);
    if (text !== null) {
      try {
        const record = JSON.parse(text) as StoredRecord;
        if (record.version !== 1) throw new Error("Unsupported record version");
        for (const client of record.clients ?? []) store.#clients.set(client.clientId, client);
        for (const [key, value] of record.codes ?? []) store.#codes.set(key, value);
        for (const [key, value] of record.access ?? []) store.#access.set(key, value);
        for (const [key, value] of record.refresh ?? []) store.#refresh.set(key, value);
      } catch {
        // An unreadable table costs the member a fresh browser sign-in, which is recoverable; refusing
        // to start would leave them with a server that never comes up and no way to repair it from a client.
        process.stderr.write(`Warning: ${path} was not a usable OAuth table; starting empty. Clients must register again.\n`);
        store.#clients.clear(); store.#codes.clear(); store.#access.clear(); store.#refresh.clear();
      }
    }
    store.sweep();
    return store;
  }

  /** Serialized so two concurrent mutations cannot interleave their snapshots and lose one. */
  #persist(): Promise<void> {
    const snapshot = (): StoredRecord => ({
      version: 1,
      clients: [...this.#clients.values()],
      codes: [...this.#codes.entries()],
      access: [...this.#access.entries()],
      refresh: [...this.#refresh.entries()],
    });
    this.#writes = this.#writes.then(() => writeProtected(this.path, snapshot()), () => writeProtected(this.path, snapshot()));
    // The maps above are the source of truth, so a failed mirror write must never fail the request
    // that caused it: rejecting here would burn an authorization code, or lose tokens the client was
    // never handed, and the member pays for that with a fresh browser sign-in and another SMS.
    return this.#writes.catch((error: unknown) => {
      process.stderr.write(`Warning: ${this.path} could not be updated (${error instanceof Error ? error.message : String(error)}); the server keeps working from memory.\n`);
    });
  }

  sweep(): void {
    const now = this.now();
    for (const [key, code] of this.#codes) if (code.expiresAt <= now) this.#codes.delete(key);
    for (const [key, token] of this.#access) if (token.expiresAt <= now) this.#access.delete(key);
    for (const [key, token] of this.#refresh) if (token.expiresAt <= now) this.#refresh.delete(key);
    for (const [id, client] of this.#clients) if (client.lastUsedAt + CLIENT_IDLE_MS <= now) this.#clients.delete(id);
  }

  async registerClient(redirectUris: string[], clientName?: string): Promise<StoredClient> {
    this.sweep();
    // Reject rather than evict: throwing out a live client's registration to make room for an unknown
    // one turns any local process into a way to sign the member out of the client they actually use.
    if (this.#clients.size >= MAX_CLIENTS) throw new OAuthError(OAuthErrorCode.TooManyRequests, "This server already holds the maximum number of registered clients. Remove oauth.json to clear them.");
    const now = this.now();
    const client: StoredClient = { clientId: randomBytes(16).toString("base64url"), redirectUris, ...(clientName === undefined ? {} : { clientName }), issuedAt: now, lastUsedAt: now };
    this.#clients.set(client.clientId, client);
    await this.#persist();
    return client;
  }

  findClient(clientId: string): StoredClient | null {
    const client = this.#clients.get(clientId);
    if (!client) return null;
    if (client.lastUsedAt + CLIENT_IDLE_MS <= this.now()) { this.#clients.delete(clientId); return null; }
    return client;
  }

  async touchClient(clientId: string): Promise<void> {
    const client = this.#clients.get(clientId);
    if (!client) return;
    client.lastUsedAt = this.now();
    await this.#persist();
  }

  async issueCode(grant: Omit<StoredCode, "expiresAt">): Promise<string> {
    const code = newSecret();
    this.#codes.set(hash(code), { ...grant, expiresAt: this.now() + CODE_TTL_MS });
    await this.#persist();
    return code;
  }

  /** Single use. A second presentation means the code leaked, so every token this subject holds goes with it. */
  async redeemCode(code: string, presented: { clientId: string; redirectUri: string; codeVerifier: string; resource: string }): Promise<RedeemedCode> {
    const key = hash(code);
    const stored = this.#codes.get(key);
    if (!stored) throw invalidGrant("The authorization code is unknown, already used or expired. Start authorization again.");
    this.#codes.delete(key);
    await this.#persist();
    if (stored.expiresAt <= this.now()) throw invalidGrant("The authorization code expired. Start authorization again.");
    if (stored.clientId !== presented.clientId) { await this.revokeSubject(stored.subject); throw invalidGrant("The authorization code was issued to a different client."); }
    if (stored.redirectUri !== presented.redirectUri) throw invalidGrant("The redirect_uri does not match the one authorization was granted for.");
    if (stored.resource !== presented.resource) throw new OAuthError(OAuthErrorCode.InvalidTarget, "The resource does not match the one authorization was granted for.");
    const challenge = createHash("sha256").update(presented.codeVerifier).digest("base64url");
    if (!equalStrings(challenge, stored.codeChallenge)) throw invalidGrant("The code_verifier does not match the code_challenge.");
    return { subject: stored.subject, resource: stored.resource, scope: stored.scope };
  }

  async issueTokens(grant: { clientId: string; subject: string; resource: string; scope: string }): Promise<IssuedTokens> {
    const now = this.now();
    const accessToken = newSecret(), refreshToken = newSecret();
    this.#access.set(hash(accessToken), { ...grant, expiresAt: now + ACCESS_TTL_MS });
    this.#refresh.set(hash(refreshToken), { ...grant, expiresAt: now + REFRESH_TTL_MS, consumed: false });
    await this.#persist();
    return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), scope: grant.scope };
  }

  /**
   * Rotation on every use, as OAuth 2.1 requires of public clients. The consumed token stays as a
   * tombstone; presenting it again means it leaked, and the answer is to revoke everything this
   * subject holds and make them sign in through the browser again.
   */
  async rotateRefresh(refreshToken: string, presented: { clientId: string; resource?: string }): Promise<IssuedTokens> {
    const key = hash(refreshToken);
    const stored = this.#refresh.get(key);
    if (!stored) throw invalidGrant("The refresh token is unknown or expired. Start authorization again.");
    if (stored.consumed) { await this.revokeSubject(stored.subject); throw invalidGrant("The refresh token was already used. Every token for this member was revoked; start authorization again."); }
    if (stored.expiresAt <= this.now()) { this.#refresh.delete(key); await this.#persist(); throw invalidGrant("The refresh token expired. Start authorization again."); }
    if (stored.clientId !== presented.clientId) { await this.revokeSubject(stored.subject); throw invalidGrant("The refresh token was issued to a different client."); }
    if (presented.resource !== undefined && presented.resource !== stored.resource) throw new OAuthError(OAuthErrorCode.InvalidTarget, "The resource does not match the one this refresh token was issued for.");
    stored.consumed = true;
    return this.issueTokens({ clientId: stored.clientId, subject: stored.subject, resource: stored.resource, scope: stored.scope });
  }

  lookupAccess(accessToken: string): StoredAccess | null {
    const key = hash(accessToken);
    const stored = this.#access.get(key);
    if (!stored) return null;
    if (stored.expiresAt <= this.now()) { this.#access.delete(key); return null; }
    return stored;
  }

  /** RFC 7009: either token type, and an unknown token is still a success. */
  async revokeToken(token: string): Promise<void> {
    const key = hash(token);
    const refresh = this.#refresh.get(key);
    if (refresh) { await this.revokeSubject(refresh.subject); return; }
    if (this.#access.delete(key)) await this.#persist();
  }

  async revokeSubject(subject: string): Promise<void> {
    for (const [key, code] of this.#codes) if (code.subject === subject) this.#codes.delete(key);
    for (const [key, token] of this.#access) if (token.subject === subject) this.#access.delete(key);
    for (const [key, token] of this.#refresh) if (token.subject === subject) this.#refresh.delete(key);
    await this.#persist();
  }

  /** Test and shutdown seam: waits for the write-through mirror to catch up with the in-memory state. */
  flush(): Promise<void> { return this.#writes; }
}
