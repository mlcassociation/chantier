import { defineConfig } from "vitest/config";

// Tests always run against package sources, never built dist output.
// The "development" export condition is first in every workspace manifest's
// exports map, so declaring it here (appended to Vite's default conditions)
// makes @chantier/* resolve to ./src/index.ts during tests.
export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
});
