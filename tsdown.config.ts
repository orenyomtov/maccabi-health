import { defineConfig } from "tsdown";
export default defineConfig({
  entry: {
    index: "packages/core/src/index.ts",
    cli: "packages/cli/src/main.ts",
    mcp: "packages/mcp/src/tools.ts",
  },
  platform: "node",
  target: "node22",
  format: "esm",
  dts: true,
  sourcemap: false,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  clean: true,
  deps: { alwaysBundle: [/^@maccabi\//] },
});
