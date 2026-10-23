// Independent-review harness only. Kept outside the default `npm test` include
// so it never changes the PR's CI result. Run with:
//   npx vitest run --config review/vitest.config.mjs
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["review/**/*.harness.ts"],
  },
});
