import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
  test: {
    // Node by default; component tests opt into jsdom via the @vitest-environment jsdom docblock.
    environment: "node",
    setupFiles: ["./tests/setup-dom.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
  },
});
