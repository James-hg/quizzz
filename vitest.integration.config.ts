import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/integration-env.ts"],
    // One shared test database: run files serially so they cannot interfere.
    fileParallelism: false,
  },
});
