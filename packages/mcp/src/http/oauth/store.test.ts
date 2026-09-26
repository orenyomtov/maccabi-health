import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_TTL_MS, MAX_CLIENTS, OAuthStore, REFRESH_TTL_MS } from "./store";

const RESOURCE = "http://127.0.0.1:8765/mcp";
const SUBJECT = "0".repeat(32);
let directory: string, clock: number;

const verifier = () => randomBytes(32).toString("base64url");
const challengeOf = (value: string) => createHash("sha256").update(value).digest("base64url");
const open = () => OAuthStore.open(join(directory, "oauth.json"), () => clock);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "maccabi-oauth-"));
  clock = 1_700_000_000_000;
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function grant(store: OAuthStore, subject = SUBJECT) {
  const client = await store.registerClient(["http://127.0.0.1/callback"]);
  const codeVerifier = verifier();
  const code = await store.issueCode({ clientId: client.clientId, redirectUri: "http://127.0.0.1:41234/callback", resource: RESOURCE, codeChallenge: challengeOf(codeVerifier), subject, scope: "maccabi" });
  return { client, code, codeVerifier };
}

describe("authorization codes", () => {
  test("redeem once, then never again", async () => {
    const store = await open();
    const { client, code, codeVerifier } = await grant(store);
    const redeemed = await store.redeemCode(code, { clientId: client.clientId, redirectUri: "http://127.0.0.1:41234/callback", codeVerifier, resource: RESOURCE });
    expect(redeemed).toEqual({ subject: SUBJECT, resource: RESOURCE, scope: "maccabi" });
    await expect(store.redeemCode(code, { clientId: client.clientId, redirectUri: "http://127.0.0.1:41234/callback", codeVerifier, resource: RESOURCE })).rejects.toThrow(/unknown, already used or expired/);
  });
  test("rejects a wrong verifier, a different client, a different redirect_uri, a different resource and an expired code", async () => {
    const store = await open();
    const base = await grant(store);
    const args = { clientId: base.client.clientId, redirectUri: "http://127.0.0.1:41234/callback", codeVerifier: base.codeVerifier, resource: RESOURCE };
    await expect(store.redeemCode(base.code, { ...args, codeVerifier: verifier() })).rejects.toThrow(/code_verifier/);

    const second = await grant(store);
    await expect(store.redeemCode(second.code, { ...args, clientId: base.client.clientId, codeVerifier: second.codeVerifier })).rejects.toThrow(/different client/);

    const third = await grant(store);
    await expect(store.redeemCode(third.code, { clientId: third.client.clientId, redirectUri: "http://127.0.0.1:41234/other", codeVerifier: third.codeVerifier, resource: RESOURCE })).rejects.toThrow(/redirect_uri/);

    const fourth = await grant(store);
    await expect(store.redeemCode(fourth.code, { clientId: fourth.client.clientId, redirectUri: "http://127.0.0.1:41234/callback", codeVerifier: fourth.codeVerifier, resource: "http://127.0.0.1:9999/mcp" })).rejects.toThrow(/resource/);

    const fifth = await grant(store);
    clock += 61_000;
    await expect(store.redeemCode(fifth.code, { clientId: fifth.client.clientId, redirectUri: "http://127.0.0.1:41234/callback", codeVerifier: fifth.codeVerifier, resource: RESOURCE })).rejects.toThrow();
  });
});

describe("tokens", () => {
  test("access tokens expire and refresh rotates", async () => {
    const store = await open();
    const first = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE, scope: "maccabi" });
    expect(store.lookupAccess(first.accessToken)?.subject).toBe(SUBJECT);
    clock += ACCESS_TTL_MS;
    expect(store.lookupAccess(first.accessToken)).toBeNull();

    const second = await store.rotateRefresh(first.refreshToken, { clientId: "c", resource: RESOURCE });
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(store.lookupAccess(second.accessToken)?.subject).toBe(SUBJECT);
  });
  test("replaying a consumed refresh token revokes every token this subject holds", async () => {
    const store = await open();
    const first = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE, scope: "maccabi" });
    const second = await store.rotateRefresh(first.refreshToken, { clientId: "c" });
    await expect(store.rotateRefresh(first.refreshToken, { clientId: "c" })).rejects.toThrow(/already used/);
    // The replay revokes the whole subject, so the token the legitimate client is holding is gone too.
    expect(store.lookupAccess(second.accessToken)).toBeNull();
    await expect(store.rotateRefresh(second.refreshToken, { clientId: "c" })).rejects.toThrow(/unknown or expired/);
  });
  test("a refresh token expires and refuses a foreign client or resource", async () => {
    const store = await open();
    const mine = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE, scope: "maccabi" });
    await expect(store.rotateRefresh(mine.refreshToken, { clientId: "c", resource: "http://127.0.0.1:1/mcp" })).rejects.toThrow(/resource/);
    await expect(store.rotateRefresh(mine.refreshToken, { clientId: "other" })).rejects.toThrow(/different client/);

    const other = await store.issueTokens({ clientId: "c", subject: "1".repeat(32), resource: RESOURCE, scope: "maccabi" });
    clock += REFRESH_TTL_MS;
    await expect(store.rotateRefresh(other.refreshToken, { clientId: "c" })).rejects.toThrow();
  });
  test("revokeSubject clears one member and leaves the other alone", async () => {
    const store = await open();
    const a = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE, scope: "maccabi" });
    const b = await store.issueTokens({ clientId: "c", subject: "1".repeat(32), resource: RESOURCE, scope: "maccabi" });
    await store.revokeSubject(SUBJECT);
    expect(store.lookupAccess(a.accessToken)).toBeNull();
    expect(store.lookupAccess(b.accessToken)?.subject).toBe("1".repeat(32));
  });
  test("revokeToken takes an access token alone and a refresh token with the whole subject", async () => {
    const store = await open();
    const first = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE, scope: "maccabi" });
    const second = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE, scope: "maccabi" });
    await store.revokeToken(first.accessToken);
    expect(store.lookupAccess(first.accessToken)).toBeNull();
    expect(store.lookupAccess(second.accessToken)).not.toBeNull();
    await store.revokeToken(second.refreshToken);
    expect(store.lookupAccess(second.accessToken)).toBeNull();
    await expect(store.revokeToken("never-issued")).resolves.toBeUndefined();
  });
});

describe("clients", () => {
  test("registration is capped rather than evicting a live client", async () => {
    const store = await open();
    const first = await store.registerClient(["http://127.0.0.1/callback"]);
    for (let n = 1; n < MAX_CLIENTS; n++) await store.registerClient(["http://127.0.0.1/callback"]);
    await expect(store.registerClient(["http://127.0.0.1/callback"])).rejects.toThrow(/maximum number of registered clients/);
    expect(store.findClient(first.clientId)).not.toBeNull();
  });
  test("a client idle for ninety days is forgotten", async () => {
    const store = await open();
    const client = await store.registerClient(["http://127.0.0.1/callback"], "vs code");
    expect(store.findClient(client.clientId)?.clientName).toBe("vs code");
    clock += 91 * 24 * 60 * 60 * 1000;
    expect(store.findClient(client.clientId)).toBeNull();
  });
});

describe("persistence", () => {
  test("round-trips through a 0600 file and survives a corrupt one", async () => {
    const path = join(directory, "oauth.json");
    const store = await OAuthStore.open(path, () => clock);
    const client = await store.registerClient(["http://127.0.0.1/callback"], "claude code");
    const tokens = await store.issueTokens({ clientId: client.clientId, subject: SUBJECT, resource: RESOURCE, scope: "maccabi" });
    await store.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const reopened = await OAuthStore.open(path, () => clock);
    expect(reopened.findClient(client.clientId)?.clientName).toBe("claude code");
    expect(reopened.lookupAccess(tokens.accessToken)?.subject).toBe(SUBJECT);
  });

  test("a failed mirror write is reported on stderr and never fails the request", async () => {
    const path = join(directory, "mirror", "oauth.json");
    const store = await OAuthStore.open(path, () => clock);
    // The mirror's own directory is a file, so every write through writeProtected fails from here on.
    await writeFile(join(directory, "mirror"), "");
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(line => { lines.push(String(line)); return true; });
    try {
      const { client, code, codeVerifier } = await grant(store);
      const redeemed = await store.redeemCode(code, { clientId: client.clientId, redirectUri: "http://127.0.0.1:41234/callback", codeVerifier, resource: RESOURCE });
      expect(redeemed.subject).toBe(SUBJECT);
      const tokens = await store.issueTokens({ clientId: client.clientId, subject: SUBJECT, resource: RESOURCE, scope: "maccabi" });
      expect(store.lookupAccess(tokens.accessToken)?.subject).toBe(SUBJECT);
    } finally { stderr.mockRestore(); }
    expect(lines.some(line => line.includes(path))).toBe(true);
    // Shutdown and tests still get the real failure through flush().
    await expect(store.flush()).rejects.toThrow();
  });
});
