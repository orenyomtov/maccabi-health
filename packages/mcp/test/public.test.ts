import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createMaccabiMcpServer } from "../src/public";

const repo = new URL("../../../", import.meta.url).pathname;

/**
 * `dist/mcp.js` is a library entry, so a client configured to run it gets a process that exits with
 * nothing on stdout and reports `CONNECTION_CLOSED` with no cause. The guard turns that into a
 * sentence naming the real server, and must stay inert for the import that is the module's purpose.
 */
describe("maccabi-health/mcp entry-point guard", () => {
  test("importing the module does not fire the guard", () => {
    // Reaching this line at all is the proof: a fired guard calls process.exit(2) during the import
    // above, which would kill the worker before any assertion ran.
    expect(typeof createMaccabiMcpServer).toBe("function");
  });

  test("running the built module as the process entry point explains what to run instead", () => {
    const child = spawnSync(process.execPath, ["dist/mcp.js"], { cwd: repo });
    expect(child.status).toBe(2);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("maccabi mcp");
  });

  test("importing the built module from another process leaves it alive and exporting the factory", () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval",
      'const m = await import("./dist/mcp.js"); process.stdout.write(Object.keys(m).join(","));'], { cwd: repo });
    expect(child.status).toBe(0);
    expect(child.stdout.toString()).toBe("createMaccabiMcpServer");
  });
});
