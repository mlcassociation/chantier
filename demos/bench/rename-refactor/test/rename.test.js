import { test } from "node:test";
import assert from "node:assert/strict";
import { loadData } from "../src/lib.js";
import { loadData as throughUsage } from "../src/usage.js";

test("rename: both modules expose loadData", () => {
  assert.deepEqual(loadData("https://x.dev"), { ok: true, url: "https://x.dev" });
  assert.deepEqual(throughUsage("https://x.dev"), { ok: true, url: "https://x.dev" });
});