import { expect, test } from "vitest";
import { MaccabiReaders, type ReadTransport } from "../src/readers";
import { ReauthenticationRequired } from "../src/errors";
const owner = { member_id: 123456789, member_id_code: "0", f_name_hebrew: "Example", l_name_hebrew: "Fixture", f_name_english: "Example", l_name_english: "Fixture", birth_date: "2000-01-01", sex: "synthetic" };
function mock(next: Response | Error) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const transport: ReadTransport = {
    setApiToken() {},
    async request(path, init) {
      calls.push({ path: String(path), init });
      if (calls.length === 1) return Response.json({ logged_customer_info: owner, current_customer_info: owner, token: { success: true, content: "synthetic-token" } });
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { transport, calls };
}

test("session renewal is one exact owner GET with no submitted credentials or expiry claim", async () => {
  const { transport, calls } = mock(new Response(null, { status: 200 }));
  const readers = await MaccabiReaders.create(transport, { memberId: owner.member_id, memberIdCode: owner.member_id_code });
  const result = await readers.renewSession();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.path).toBe("/sonline/MainAppAPI/webapi/mac/v1/members/0/123456789/alive");
  expect(calls[1]!.init?.method ?? "GET").toBe("GET");
  expect(calls[1]!.init?.body).toBeUndefined();
  expect(calls[1]!.init?.headers).toBeUndefined();
  expect(result.data).toEqual({ renewed: true });
  expect(result.source).toMatchObject({ service: "MainAppAPI", operation: "session-renewal", completeness: "upstream-response" });
  expect(result).not.toHaveProperty("expiresAt");
  expect(JSON.stringify(result)).not.toContain("synthetic-token");
});

test("renewal rejects non-success and changed body without reflecting server text or retrying", async () => {
  for (const response of [new Response("SECRET BODY", { status: 503 }), new Response(null, { status: 204 }), new Response("SECRET BODY", { status: 200 })]) {
    const { transport, calls } = mock(response);
    const readers = await MaccabiReaders.create(transport);
    try { await readers.renewSession(); throw new Error("Expected rejection"); }
    catch (e) { expect(e instanceof Error && e.message).not.toContain("SECRET BODY"); expect(e).toHaveProperty("code"); }
    expect(calls).toHaveLength(2);
  }
});

test("expired sessions preserve typed reauthentication with no retry or new challenge", async () => {
  const expired = new ReauthenticationRequired(302);
  const { transport, calls } = mock(expired);
  const readers = await MaccabiReaders.create(transport);
  await expect(readers.renewSession()).rejects.toBe(expired);
  expect(calls).toHaveLength(2);
});
