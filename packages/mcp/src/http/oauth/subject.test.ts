import { describe, expect, test } from "vitest";
import { credentialPath, subjectOf } from "./subject";

describe("subject derivation", () => {
  test("is stable, 32 lowercase hex, and distinct per member", () => {
    const a = subjectOf({ memberId: 123456789, memberIdCode: "0" });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(subjectOf({ memberId: 123456789, memberIdCode: "0" })).toBe(a);
    expect(subjectOf({ memberId: 987654321, memberIdCode: "0" })).not.toBe(a);
    expect(subjectOf({ memberId: 123456789, memberIdCode: "1" })).not.toBe(a);
  });
  test("credentialPath refuses anything that is not a derived subject", () => {
    const subject = subjectOf({ memberId: 1, memberIdCode: "0" });
    expect(credentialPath("/tmp/sessions", subject)).toBe(`/tmp/sessions/${subject}.json`);
    for (const bad of ["../escape", "", "ABCDEF0123456789abcdef0123456789", "0123456789abcdef", `${subject}/x`]) {
      expect(() => credentialPath("/tmp/sessions", bad)).toThrow();
    }
  });
});
