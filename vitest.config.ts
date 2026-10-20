import { configDefaults, defineConfig } from "vitest/config";

// Tests always run against package sources, never built dist output.
// The "development" export condition is first in every workspace manifest's
// exports map, so declaring it here (appended to Vite's default conditions)
// makes @chantier/* resolve to ./src/index.ts during tests.
export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
  // demos/wordcount-app is a recorded-demo fixture (node --test style) that
  // ships with the README's GIF recipe -- part of demos, not of this suite.
  exclude: [...configDefaults.exclude, "demos/**"],
});