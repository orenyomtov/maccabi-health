import { describe, expect, test } from "vitest";
import { AccountAccessContentError, projectAccountAccess } from "../src/readers/account-access";

describe("account-access source projection", () => {
  test("normalizes the captured null collection to an explicit empty owner view", () => {
    expect(projectAccountAccess({ users: null, messages: [{ type: "W-Warning", message: "source text", private: "omit" }] })).toEqual({ state: "creation-available", users: [] });
  });

  test("preserves only fields displayed for an existing authorized viewer", () => {
    const source = {
      users: [{
        first_name: "שם",
        last_name: "דוגמה",
        user_id: 123456,
        authentication_end_date: "2030-01-02",
        user_technical_id: "private-key",
        patient_relation_id: "private-write-routing",
        private: "omit",
      }],
      messages: [{ type: "S-Success", message: "source text" }],
    };
    const projected = projectAccountAccess(source);
    expect(projected).toEqual({ state: "viewer-list", users: [{ first_name: "שם", last_name: "דוגמה", user_id: 123456, authentication_end_date: "2030-01-02" }] });
    source.users[0]!.first_name = "mutated";
    expect(projected.users[0]!.first_name).toBe("שם");
    expect(JSON.stringify(projected)).not.toMatch(/private|technical|relation|message/i);
  });

  test("accepts the renderer's string identification value without coercing it", () => {
    expect(projectAccountAccess({ users: [{ first_name: "A", last_name: "B", user_id: "001", authentication_end_date: "source-date" }], messages: [{ type: "S-Success", message: "source" }] }).users[0]!.user_id).toBe("001");
  });

  test("rejects absent, malformed, oversized and unsafe populated fields", () => {
    for (const value of [
      {},
      { users: {} },
      { users: null, messages: [{ type: "other", message: "source" }] },
      { users: [{}], messages: [{ type: "W-Warning", message: "source" }] },
      { users: Array.from({ length: 101 }, () => ({})), messages: [{ type: "S-Success", message: "source" }] },
      { users: [{ first_name: null, last_name: "B", user_id: 1, authentication_end_date: "date" }], messages: [{ type: "S-Success", message: "source" }] },
      { users: [{ first_name: "A", last_name: "B", user_id: -1, authentication_end_date: "date" }], messages: [{ type: "S-Success", message: "source" }] },
      { users: [{ first_name: "A", last_name: "B", user_id: 1, authentication_end_date: "x\u0000" }], messages: [{ type: "S-Success", message: "source" }] },
    ]) expect(() => projectAccountAccess(value)).toThrow(AccountAccessContentError);
  });
});
