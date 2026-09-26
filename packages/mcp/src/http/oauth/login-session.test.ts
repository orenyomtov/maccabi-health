import { describe, expect, test } from "vitest";
import { AuthorizeSessions, MAX_SESSIONS, clearedCookie, sessionCookie, type AuthorizeParams } from "./login-session";

const PARAMS: AuthorizeParams = {
  clientId: "client-1", redirectUri: "http://127.0.0.1:7331/callback", codeChallenge: "x".repeat(43),
  resource: "http://127.0.0.1:41234/mcp", scope: "maccabi", clientLabel: "A client",
};
const value = (header: string) => header.split(";")[0]!;

describe("the sign-in slot table", () => {
  test("a full table gives up an untouched page but never one holding a challenge", () => {
    const sessions = new AuthorizeSessions();
    const open = Array.from({ length: MAX_SESSIONS }, () => sessions.create(PARAMS)!);
    const ninth = sessions.create(PARAMS);
    // Nobody typed into the oldest page, so nothing upstream is lost by dropping it.
    expect(ninth).not.toBeNull();
    expect(sessions.get(open[0]!.id)).toBeNull();

    // Once every slot holds a live challenge, evicting one would cost that member an SMS, so it refuses.
    for (const session of [...open.slice(1), ninth!]) session.phase = "otp";
    expect(sessions.create(PARAMS)).toBeNull();
  });
});

describe("the sign-in cookie", () => {
  test("each session has its own name, and only its own secret opens it", () => {
    const sessions = new AuthorizeSessions();
    const a = sessions.create(PARAMS)!, b = sessions.create(PARAMS)!;
    // What one browser profile sends back once two sign-in tabs are open.
    const jar = `${value(sessionCookie(a))}; ${value(sessionCookie(b))}`;
    expect(sessions.checkCookie(a, jar)).toBe(true);
    expect(sessions.checkCookie(b, jar)).toBe(true);

    expect(sessions.checkCookie(a, value(sessionCookie(b)))).toBe(false);
    expect(sessions.checkCookie(a, `maccabi_login_${a.id}=${b.secret}`)).toBe(false);
    expect(sessions.checkCookie(a, undefined)).toBe(false);
    // Clearing names one tab, so finishing or failing in one never logs the other one out.
    expect(clearedCookie(a.id)).toContain(`maccabi_login_${a.id}=;`);
  });
});
