import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { PAGE_HEADERS, donePage, otpPage } from "./pages";

describe("sign-in pages", () => {
  test("CSP allows the submit lock and nothing else", () => {
    const html = otpPage("session", "csrf", "05X-XXXX");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toContain('e.preventDefault()');
    expect(script).toContain("b.disabled=true");
    const hash = createHash("sha256").update(script ?? "").digest("base64");
    expect(PAGE_HEADERS["content-security-policy"]).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; form-action 'self'`,
    );
  });

  test("a finished browser login tells the member to message the agent", () => {
    const html = donePage();
    expect(html).toContain("Message the agent and tell it you have logged in.");
    expect(html).not.toContain("Close this window");
  });
});
