import { describe, expect, test } from "vitest";
import { login } from "./client";

describe("login", () => {
  test("rejects a bad id before any request", async () => {
    await expect(login("nope")).rejects.toMatchObject({ code: "INVALID_ID_FORMAT" });
  });
});
