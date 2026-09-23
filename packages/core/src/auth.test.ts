import { describe, expect, test } from "vitest";
import { MaccabiAuth } from "./auth";
import { AuthenticationError, ReauthenticationRequired, UpstreamError } from "./errors";
import { LOGIN_ORIGIN, MaccabiTransport, PORTAL_ORIGIN } from "./transport";

const home = PORTAL_ORIGIN + "/sonline/homepage/NotificationAndUpdates/";
function response(url: string, body: string | null, status = 200, headers: HeadersInit = {}): Response {
  const value = new Response(body, { status, headers });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

/** All credentials, phone numbers, tokens and response bodies here are synthetic. */
function fixture(options: { otpCode?: number; failAcs?: boolean; unrelatedHome?: boolean; now?: () => number; phones?: unknown[] | null; smsIndex?: number } = {}) {
  const calls: { url: URL; init: RequestInit; headers: Headers }[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    calls.push({ url, init, headers });
    expect(init.redirect).toBe("manual");
    const json = (body: unknown, status = 200) => response(url.href, JSON.stringify(body), status, { "content-type": "application/json" });
    switch (url.origin + url.pathname) {
      case PORTAL_ORIGIN + "/":
        if (headers.get("cookie")?.includes("MRHSession=synthetic-session")) {
          return response(url.href, null, 302, { location: options.unrelatedHome ? PORTAL_ORIGIN + "/unrelated" : home });
        }
        return response(url.href, null, 302, { location: "/my.policy", "set-cookie": "preauth=synthetic-preauth; Path=/; Secure; HttpOnly" });
      case PORTAL_ORIGIN + "/my.policy":
        expect(headers.get("cookie")).toContain("preauth=synthetic-preauth");
        return response(url.href, null, 302, { location: LOGIN_ORIGIN + "/login?SAMLRequest=synthetic-request" });
      case LOGIN_ORIGIN + "/login":
        expect(headers.get("cookie") ?? "").not.toContain("preauth=");
        return response(url.href, '<script>window.originJWT="synthetic.origin.jwt";</script>', 200, { "content-type": "text/html" });
      case LOGIN_ORIGIN + "/infosec/auth":
        expect(headers.get("authorization")).toBe("Bearer synthetic.origin.jwt");
        expect(headers.get("origin")).toBe(LOGIN_ORIGIN);
        expect(JSON.parse(String(init.body))).toEqual({ id: "0-12345678", password: "", type: "none" });
        return json({ status: "ok", jwt: "synthetic.auth.jwt", message: "" });
      case LOGIN_ORIGIN + "/infosec/otp/detailsV2":
        expect(headers.get("authorization")).toBe("Bearer synthetic.auth.jwt");
        return json({ status: "ok", jwt: "synthetic.sender.jwt", details: {
          allowedAge: true, digitalUser: true,
          phones: Object.hasOwn(options, "phones") ? options.phones : [{ number: "0500000012", mobile: true, kosher: false }, { number: "030000034", mobile: false, kosher: false }],
        } });
      case LOGIN_ORIGIN + "/infosec/otp/generateV2":
        expect(headers.get("authorization")).toBe("Bearer synthetic.sender.jwt");
        expect(url.searchParams.get("target")).toBe("sms");
        expect(url.searchParams.get("phone")).toBe(String(options.smsIndex ?? 0));
        return json({ status: "ok", jwt: "synthetic.validator.jwt", message: "" });
      case LOGIN_ORIGIN + "/infosec/otp/validate":
        expect(headers.get("authorization")).toBe("Bearer synthetic.validator.jwt");
        expect(url.searchParams.get("otp")).toBe("123456");
        return options.otpCode ? json({ code: options.otpCode }, 400) : json({ status: "ok", jwt: "synthetic.verified.jwt", message: "" });
      case LOGIN_ORIGIN + "/infosec/response":
        expect(headers.get("authorization")).toBe("Bearer synthetic.verified.jwt");
        expect(headers.get("relay")).toBe("home");
        return json({ status: "ok", method: "post", destination: PORTAL_ORIGIN + "/saml/sp/profile/post/acs", payload: {
          SAMLResponse: "synthetic-saml", RelayState: "",
        } });
      case PORTAL_ORIGIN + "/saml/sp/profile/post/acs":
        expect(headers.has("authorization")).toBe(false);
        expect(headers.get("cookie")).toContain("preauth=synthetic-preauth");
        expect(new URLSearchParams(String(init.body)).get("SAMLResponse")).toBe("synthetic-saml");
        expect(new URLSearchParams(String(init.body)).has("RelayState")).toBe(true);
        if (options.failAcs) return response(url.href, "Not signed in", 200, { "content-type": "text/html" });
        return response(url.href, null, 302, { location: "/", "set-cookie": "MRHSession=synthetic-session; Path=/; Secure; HttpOnly" });
      case home:
        expect(init.method).toBe("GET");
        expect(init.body).toBeUndefined();
        return response(url.href, "<html>synthetic portal</html>", 200, { "content-type": "text/html" });
      case PORTAL_ORIGIN + "/unrelated":
        return response(url.href, "<html>unrelated page</html>", 200, { "content-type": "text/html" });
      default: throw new Error("Unexpected synthetic request");
    }
  });
  const transport = new MaccabiTransport({ fetch });
  return { calls, transport, auth: new MaccabiAuth(transport, { now: options.now }) };
}

describe("observed ID/SMS/SAML flow", () => {
  test("progresses distinct challenge tokens and preserves cookies across SAML redirects", async () => {
    const { calls, auth, transport } = fixture();
    const challenge = await auth.beginLogin("012345678");
    expect(challenge.phones).toEqual([
      { index: 0, label: "Phone ending 0012", display: "ending 0012", smsAvailable: true },
      { index: 1, label: "Phone ending 0034", display: "ending 0034", smsAvailable: false },
    ]);
    expect(calls.some(call => call.url.pathname.endsWith("generateV2"))).toBe(false);
    await auth.requestOtp(challenge.id);
    const session = await auth.completeLogin(challenge.id, "123456");
    expect(session.version).toBe(1);
    expect(session.cookies.cookies.some(cookie => cookie.key === "MRHSession")).toBe(true);
    expect(JSON.stringify(session)).not.toContain("synthetic.validator.jwt");
    expect(JSON.stringify(session)).not.toContain("synthetic-saml");
    expect(JSON.stringify(session)).not.toContain("123456");
    transport.setApiToken("synthetic.portal.jwt");
    expect((await transport.exportSession()).apiAuthorization).toBe("Bearer synthetic.portal.jwt");
    await expect(auth.completeLogin(challenge.id, "123456")).rejects.toMatchObject({ code: "UNKNOWN_LOGIN_CHALLENGE" });
  });

  test("invalid phone choice or malformed OTP never sends another request", async () => {
    const { auth, calls } = fixture();
    const challenge = await auth.beginLogin("012345678");
    const before = calls.length;
    await expect(auth.requestOtp(challenge.id, 1)).rejects.toMatchObject({ code: "INVALID_PHONE_CHOICE" });
    // Six digits exactly. Maccabi allows one attempt per code and locks the account on a wrong one, so
    // a mistyped length has to die here rather than be spent upstream; "abc123" alone would still pass
    // a check that had been widened to any run of digits.
    for (const otp of ["abc123", "12345", "1234567", "1234", "", "12345 ", "١٢٣٤٥٦"]) {
      await expect(auth.completeLogin(challenge.id, otp)).rejects.toMatchObject({ code: "INVALID_OTP_FORMAT" });
    }
    expect(calls.length).toBe(before);
  });

  /** The retention window closes at the boundary, not one tick after it. */
  test("a challenge is already expired at the instant its retention window ends", async () => {
    let now = 0;
    const { auth, calls } = fixture({ now: () => now });
    const challenge = await auth.beginLogin("012345678");
    const count = calls.length;
    now = 10 * 60_000;
    await expect(auth.requestOtp(challenge.id)).rejects.toMatchObject({ code: "LOGIN_CHALLENGE_EXPIRED" });
    // Expiry is local retention, so it must not have cost an SMS on the way out.
    expect(calls).toHaveLength(count);
  });

  test("exact duplicate masked phone entries become one choice with the original upstream index", async () => {
    const { auth, calls } = fixture({ phones: [
      { number: "0300000000", mobile: false, kosher: false },
      { number: "05*-****012", mobile: true, kosher: false },
      { number: "05*-****012", mobile: true, kosher: false },
    ], smsIndex: 1 });
    const challenge = await auth.beginLogin("012345678");
    const eligible = challenge.phones.filter(phone => phone.smsAvailable);
    expect(eligible).toEqual([{ index: 1, label: "Phone 05*-****012", display: "05*-****012", smsAvailable: true }]);
    await auth.requestOtp(challenge.id);
    expect(calls.filter(call => call.url.pathname.endsWith("generateV2"))).toHaveLength(1);
  });

  test("display carries the bare value for each label shape: supplied mask, ending NNNN, and ordinal", async () => {
    const { auth } = fixture({ phones: [
      { number: "05*-****012", mobile: true, kosher: false },
      { number: "0500000034", mobile: true, kosher: false },
      { number: "", mobile: true, kosher: false },
    ] });
    const challenge = await auth.beginLogin("012345678");
    expect(challenge.phones).toEqual([
      { index: 0, label: "Phone 05*-****012", display: "05*-****012", smsAvailable: true },
      { index: 1, label: "Phone ending 0034", display: "ending 0034", smsAvailable: true },
      { index: 2, label: "Phone 3", display: "3", smsAvailable: true },
    ]);
  });

  test("distinct phone numbers sharing the displayed suffix remain separate choices", async () => {
    const { auth } = fixture({ phones: [
      { number: "0501110012", mobile: true, kosher: false },
      { number: "0522220012", mobile: true, kosher: false },
    ], smsIndex: 1 });
    const challenge = await auth.beginLogin("012345678");
    expect(challenge.phones.map(phone => phone.index)).toEqual([0, 1]);
    expect(new Set(challenge.phones.map(phone => phone.label)).size).toBe(2);
    expect(challenge.phones.every(phone => !phone.label.includes("050111") && !phone.label.includes("052222"))).toBe(true);
    await auth.requestOtp(challenge.id, 1);
  });

  test("empty or absent phone lists report SMS unavailable without requesting an SMS", async () => {
    for (const phones of [[], null, undefined]) {
      const { auth, calls } = fixture({ phones });
      await expect(auth.beginLogin("012345678")).rejects.toMatchObject({ code: "SMS_NOT_AVAILABLE" });
      expect(calls.some(call => call.url.pathname.endsWith("generateV2"))).toBe(false);
    }
  });

  test("upstream OTP expiry is typed and does not resend SMS", async () => {
    const { auth, calls } = fixture({ otpCode: 302 });
    const challenge = await auth.beginLogin("012345678");
    await auth.requestOtp(challenge.id);
    await expect(auth.completeLogin(challenge.id, "123456")).rejects.toMatchObject({ code: "OTP_EXPIRED" });
    await expect(auth.completeLogin(challenge.id, "123456")).rejects.toMatchObject({ code: "UNKNOWN_LOGIN_CHALLENGE" });
    expect(calls.filter(call => call.url.pathname.endsWith("generateV2"))).toHaveLength(1);
  });

  test("an arbitrary ACS 200 page cannot be promoted to an authenticated session", async () => {
    const { auth, transport } = fixture({ failAcs: true });
    const challenge = await auth.beginLogin("012345678");
    await auth.requestOtp(challenge.id);
    await expect(auth.completeLogin(challenge.id, "123456")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(transport.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
  });

  test("an unrelated final HTML page is rejected even when ACS set a session cookie", async () => {
    const { auth, transport } = fixture({ unrelatedHome: true });
    const challenge = await auth.beginLogin("012345678");
    await auth.requestOtp(challenge.id);
    await expect(auth.completeLogin(challenge.id, "123456")).rejects.toMatchObject({ code: "PORTAL_SESSION_UNCONFIRMED" });
    await expect(transport.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
  });

  test("local challenge retention expiry and cancellation send no network request", async () => {
    let now = 0;
    const { auth, calls } = fixture({ now: () => now });
    const challenge = await auth.beginLogin("012345678");
    const count = calls.length;
    now = 11 * 60_000;
    await expect(auth.requestOtp(challenge.id)).rejects.toMatchObject({ code: "LOGIN_CHALLENGE_EXPIRED" });
    expect(calls).toHaveLength(count);
    const next = await auth.beginLogin("012345678");
    const afterBegin = calls.length;
    await auth.cancelLogin();
    await expect(auth.requestOtp(next.id)).rejects.toMatchObject({ code: "UNKNOWN_LOGIN_CHALLENGE" });
    expect(calls).toHaveLength(afterBegin);
  });
});

describe("cookie and session boundaries", () => {
  test("rejects foreign redirect destinations before any second request", async () => {
    let count = 0;
    const transport = new MaccabiTransport({ fetch: (async () => {
      count++;
      return new Response(null, { status: 302, headers: { location: "https://unrelated.example/" } });
    }) });
    await expect(transport.request(PORTAL_ORIGIN)).rejects.toMatchObject({ code: "UNSUPPORTED_ORIGIN" });
    expect(count).toBe(1);
  });

  test("restored session expiration becomes reauthentication, not empty records", async () => {
    const { auth } = fixture();
    const challenge = await auth.beginLogin("012345678");
    await auth.requestOtp(challenge.id);
    const session = await auth.completeLogin(challenge.id, "123456");
    let count = 0;
    const restored = new MaccabiTransport({ session, fetch: (async (_input, init) => {
      count++;
      expect(new Headers(init?.headers).get("cookie")).toContain("MRHSession=synthetic-session");
      return new Response(null, { status: 302, headers: { location: "/my.policy" } });
    }) });
    await expect(restored.requestJson("/sonline/synthetic/read")).rejects.toBeInstanceOf(ReauthenticationRequired);
    await expect(restored.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
    expect(await restored.hasPortalSession()).toBe(false);
    expect(count).toBe(1);
  });

  test("a 401 or 403 on a protected request fails that request without destroying the session", async () => {
    const { auth } = fixture();
    const challenge = await auth.beginLogin("012345678");
    await auth.requestOtp(challenge.id);
    const session = await auth.completeLogin(challenge.id, "123456");
    const names = session.cookies.cookies.map(cookie => cookie.key).sort();
    for (const status of [401, 403]) {
      let count = 0;
      const restored = new MaccabiTransport({ session, fetch: (async () => { count++; return new Response(null, { status }); }) });
      const failure = await restored.request("/sonline/synthetic/read").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UpstreamError);
      expect(failure).not.toBeInstanceOf(ReauthenticationRequired);
      expect(failure).toMatchObject({ code: "HTTP_ERROR", status });
      expect(await restored.hasPortalSession()).toBe(true);
      expect((await restored.exportSession()).cookies.cookies.map(cookie => cookie.key).sort()).toEqual(names);
      expect(count).toBe(1);
    }
  });

  test("the expiry redirect still clears the jar even though F5 hands back a fresh MRHSession", async () => {
    const { auth } = fixture();
    const challenge = await auth.beginLogin("012345678");
    await auth.requestOtp(challenge.id);
    const session = await auth.completeLogin(challenge.id, "123456");
    let count = 0;
    const restored = new MaccabiTransport({ session, fetch: (async () => {
      count++;
      return new Response(null, { status: 302, headers: { location: PORTAL_ORIGIN + "/my.policy", "set-cookie": "MRHSession=synthetic-anonymous; Path=/; Secure" } });
    }) });
    await expect(restored.request("/sonline/synthetic/read")).rejects.toBeInstanceOf(ReauthenticationRequired);
    expect(await restored.hasPortalSession()).toBe(false);
    await expect(restored.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
    expect(count).toBe(1);
  });

  test("network exceptions cannot leak OTP URLs into errors", async () => {
    const transport = new MaccabiTransport({ fetch: (async () => {
      throw new Error("Sensitive URL with synthetic OTP 123456");
    }) });
    try { await transport.request(LOGIN_ORIGIN + "/infosec/otp/validate?otp=123456"); }
    catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect(String(error)).not.toContain("123456");
      expect((error as Error).cause).toBeUndefined();
      return;
    }
    throw new Error("Expected safe transport failure");
  });
});
