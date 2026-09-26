import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/{src,test}/**/*.test.ts", "scripts/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
