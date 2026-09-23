import { describe, expect, test } from "vitest";
import { HTTPS_REDIRECT_ALLOWLIST, isRegistrableRedirect, matchesRegistered } from "./redirect";

describe("redirect_uri rule A — loopback", () => {
  test("accepts the three loopback hostnames, including localhost", () => {
    // Claude Code registers localhost and 127.0.0.1 and comes back on localhost; rejecting it broke sign-in.
    for (const uri of ["http://127.0.0.1/callback", "http://[::1]/callback", "http://localhost/callback", "http://localhost:53123/callback"]) {
      expect(isRegistrableRedirect(uri)).toBe(true);
    }
  });
  test("rejects a non-loopback host, https on a loopback name, userinfo, a query and a fragment", () => {
    for (const uri of [
      "http://attacker.example/callback",
      "http://127.0.0.1.attacker.example/callback",
      "https://localhost/callback",
      "http://user:pass@127.0.0.1/callback",
      "http://user@127.0.0.1/callback",
      "http://127.0.0.1/callback?next=https://evil.example",
      "http://127.0.0.1/callback#fragment",
      "not a url",
      "",
    ]) {
      expect(isRegistrableRedirect(uri), uri).toBe(false);
    }
  });
  test("matching varies only by port", () => {
    expect(matchesRegistered("http://127.0.0.1:1/callback", "http://127.0.0.1:41234/callback")).toBe(true);
    expect(matchesRegistered("http://localhost/callback", "http://localhost:41234/callback")).toBe(true);
    expect(matchesRegistered("http://127.0.0.1:1/callback", "http://127.0.0.1:41234/other")).toBe(false);
    // localhost and 127.0.0.1 are both accepted, but they are still different registrations.
    expect(matchesRegistered("http://127.0.0.1:1/callback", "http://localhost:1/callback")).toBe(false);
    expect(matchesRegistered("http://127.0.0.1:1/callback", "http://[::1]:1/callback")).toBe(false);
    expect(matchesRegistered("http://127.0.0.1:1/callback", "http://127.0.0.1:41234/callback?code=x")).toBe(false);
    expect(matchesRegistered("http://127.0.0.1:1/callback", "https://127.0.0.1:41234/callback")).toBe(false);
  });
});

describe("redirect_uri rule B — https allowlist", () => {
  test("accepts the two VS Code URIs exactly", () => {
    expect(HTTPS_REDIRECT_ALLOWLIST).toEqual(["https://vscode.dev/redirect", "https://insiders.vscode.dev/redirect"]);
    for (const uri of HTTPS_REDIRECT_ALLOWLIST) {
      expect(isRegistrableRedirect(uri)).toBe(true);
      expect(matchesRegistered(uri, uri)).toBe(true);
    }
  });
  test("rejects every near miss", () => {
    for (const uri of [
      "https://vscode.dev/redirect/x",
      "https://vscode.dev/redirect?x=1",
      "https://vscode.dev/redirect#x",
      "https://vscode.dev/redirect/",
      "https://vscode.dev/Redirect",
      "https://evil-vscode.dev/redirect",
      "https://vscode.dev.evil.example/redirect",
      "https://user@vscode.dev/redirect",
      "http://vscode.dev/redirect",
      "https://insiders.vscode.dev/redirect/x",
    ]) {
      expect(isRegistrableRedirect(uri), uri).toBe(false);
    }
  });
  test("an allowlisted registration never widens at authorize time", () => {
    for (const presented of ["https://vscode.dev/redirect/x", "https://vscode.dev/redirect?code=1", "https://insiders.vscode.dev/redirect"]) {
      expect(matchesRegistered("https://vscode.dev/redirect", presented), presented).toBe(false);
    }
  });
});
