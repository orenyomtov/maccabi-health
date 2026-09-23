import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/**
 * 0.1.0 fixes these two lists. A name that ships cannot be withdrawn without a major bump, and a name
 * that ships by accident - a helper re-exported from a barrel, or a declaration-emit change riding in
 * on one of dependabot's grouped dev-dependency bumps, with TypeScript 7.0.2 emitting these `.d.ts`
 * files through an experimental API - is just as permanent. So the surface is pinned by name: adding
 * or removing one has to be a deliberate edit here, in the same commit that does it.
 */
describe("published export surface", () => {
  const CORE_VALUES = [
    "AuthenticationError", "ISSUES_URL", "MaccabiAuth", "MaccabiDirectory", "MaccabiError", "MaccabiReaders",
    "MaccabiTransport", "OMITTED_KEYS", "READ_ERROR_GUIDANCE", "ReadOperationError", "ReauthenticationRequired",
    "UpstreamError", "safeClinical",
  ];
  const CORE_TYPES = [
    "DirectoryCategory", "DirectoryDoctor", "DirectoryOptions", "DirectoryProviderDetails", "DoctorCity",
    "DoctorSearchOptions", "DoctorSearchResult", "DoctorSpecialty", "LoginChallenge", "LoginPhoneChoice",
    "MaccabiSession", "OwnerIdentity", "PendingLogin", "ProviderSearchResult", "ReadErrorCode", "ReadResult",
    "SourceRecord", "TransportOptions",
  ];
  const MCP_VALUES = ["createMaccabiMcpServer"];
  const MCP_TYPES = ["MaccabiMcpOptions"];

  /** Every name the emitted declarations export, whichever of the two shapes tsdown wrote it in. */
  function declared(file: string): string[] {
    const source = readFileSync(new URL(`../../../dist/${file}`, import.meta.url), "utf8");
    const names = new Set<string>();
    for (const [, name] of source.matchAll(/^export (?:declare )?(?:abstract class|class|const|function|enum|interface|namespace|type)\s+(\w+)/gm)) names.add(name);
    for (const [, body] of source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
      for (const entry of body.split(",")) {
        const name = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (name) names.add(name);
      }
    }
    return [...names].sort();
  }

  test("the built library entry exports exactly these runtime names", async () => {
    const entry = await import(new URL("../../../dist/index.js", import.meta.url).href) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(CORE_VALUES);
  });

  test("the built MCP entry exports exactly these runtime names", async () => {
    const entry = await import(new URL("../../../dist/mcp.js", import.meta.url).href) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(MCP_VALUES);
  });

  // Failing at the source is a better error than failing after a build, and it also proves the two
  // public.ts modules are what the bundler was given rather than something re-derived.
  test("the source entries name the same runtime exports as the built ones", async () => {
    const core = await import("../../core/src/public") as Record<string, unknown>;
    const mcp = await import("../src/public") as Record<string, unknown>;
    expect(Object.keys(core).sort()).toEqual(CORE_VALUES);
    expect(Object.keys(mcp).sort()).toEqual(MCP_VALUES);
  });

  test("the shipped declarations carry those names and no others", () => {
    expect(declared("index.d.ts")).toEqual([...CORE_VALUES, ...CORE_TYPES].sort());
    expect(declared("mcp.d.ts")).toEqual([...MCP_VALUES, ...MCP_TYPES].sort());
  });
});
