import { defineConfig } from "vitest/config";

// Only Node/Vitest tests (*.test.ts). Deno tests (*_test.ts, which import
// jsr: specifiers) run under `deno test`, never under Node.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*_test.ts"],
  },
});
