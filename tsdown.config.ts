import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

/**
 * The library entries point at the narrow `public.ts` modules, not the workspace barrels the other
 * packages import. `index.ts` and `tools.ts` stay as they are, because thirteen internal call sites
 * and the tests import them directly; what ships is the subset.
 */
export default defineConfig({
  entry: {
    index: "packages/core/src/public.ts",
    cli: "packages/cli/src/main.ts",
    mcp: "packages/mcp/src/public.ts",
  },
  platform: "node",
  target: "node22",
  format: "esm",
  dts: true,
  sourcemap: false,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  clean: true,
  deps: { alwaysBundle: [/^@maccabi\//] },
  hooks: {
    // The CLI entry is a `bin`, not an importable module: its declarations are an empty `export {}`
    // that nothing can consume. dts is per-build rather than per-entry, and splitting the build in
    // two to suppress one file would duplicate the ~230 KB core chunk that cli.js shares with the
    // library entries, so the file is removed after the fact instead.
    "build:done": async () => {
      await rm(fileURLToPath(new URL("dist/cli.d.ts", import.meta.url)), { force: true });
    },
  },
});
