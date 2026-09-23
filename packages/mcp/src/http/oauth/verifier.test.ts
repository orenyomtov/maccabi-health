import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBearerToken } from "@modelcontextprotocol/server";
import { ACCESS_TTL_MS, OAuthStore } from "./store";
import { createTokenVerifier, subjectFrom } from "./verifier";

const RESOURCE = new URL("http://127.0.0.1:8765/mcp");
const SUBJECT = "a".repeat(32);
let directory: string, clock: number, store: OAuthStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "maccabi-verifier-"));
  clock = 1_700_000_000_000;
  store = await OAuthStore.open(join(directory, "oauth.json"), () => clock);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("access token verification", () => {
  test("a good token carries the subject and an expiry in seconds", async () => {
    const verifier = createTokenVerifier(store, RESOURCE);
    const { accessToken } = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE.href, scope: "maccabi" });
    const info = await verifier.verifyAccessToken(accessToken);
    expect(info.extra?.["subject"]).toBe(SUBJECT);
    expect(subjectFrom(info)).toBe(SUBJECT);
    expect(info.scopes).toEqual(["maccabi"]);
    expect(info.expiresAt).toBe(Math.floor((clock + ACCESS_TTL_MS) / 1000));
    expect(info.resource?.href).toBe(RESOURCE.href);
  });
  test("unknown, revoked, expired and foreign-resource tokens all fail", async () => {
    const verifier = createTokenVerifier(store, RESOURCE);
    await expect(verifier.verifyAccessToken("never-issued")).rejects.toThrow(/unknown, revoked or expired/);

    const revoked = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE.href, scope: "maccabi" });
    await store.revokeSubject(SUBJECT);
    await expect(verifier.verifyAccessToken(revoked.accessToken)).rejects.toThrow(/unknown, revoked or expired/);

    const expiring = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE.href, scope: "maccabi" });
    clock += ACCESS_TTL_MS;
    await expect(verifier.verifyAccessToken(expiring.accessToken)).rejects.toThrow(/unknown, revoked or expired/);

    // Issued for a different MCP server on the same machine: this is the audience check the SDK does not do.
    const foreign = await store.issueTokens({ clientId: "c", subject: SUBJECT, resource: "http://127.0.0.1:9999/mcp", scope: "maccabi" });
    await expect(verifier.verifyAccessToken(foreign.accessToken)).rejects.toThrow(/different resource/);
  });
  test("the SDK bearer path accepts the AuthInfo this verifier returns", async () => {
    // Real clock here: verifyBearerToken compares expiresAt against the wall clock, not our test one.
    const live = await OAuthStore.open(join(directory, "live.json"));
    const verifier = createTokenVerifier(live, RESOURCE);
    const { accessToken } = await live.issueTokens({ clientId: "c", subject: SUBJECT, resource: RESOURCE.href, scope: "maccabi" });
    const info = await verifyBearerToken(`Bearer ${accessToken}`, { verifier });
    expect(info.clientId).toBe("c");
    await expect(verifyBearerToken(undefined, { verifier })).rejects.toThrow();
    await expect(verifyBearerToken(`Bearer ${accessToken}`, { verifier, requiredScopes: ["other"] })).rejects.toThrow();
  });
  test("subjectFrom refuses anything that is not a derived subject", () => {
    for (const extra of [undefined, {}, { subject: 7 }, { subject: "short" }, { subject: "A".repeat(32) }]) {
      expect(() => subjectFrom(extra === undefined ? undefined : { token: "t", clientId: "c", scopes: [], extra } as never)).toThrow();
    }
  });
});
