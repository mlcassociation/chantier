import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIso } from "../src/parse-iso.js";

test("dashes", () => {
  assert.deepEqual(parseIso("2026-10-20"), { year: 2026, month: 10, day: 20 });
});

test("slashes", () => {
  assert.deepEqual(parseIso("2026/10/20"), { year: 2026, month: 10, day: 20 });
});

test("impossible date", () => {
  assert.equal(parseIso("2026-02-30"), null);
});

test("garbage", () => {
  assert.equal(parseIso("yesterday"), null);
  assert.equal(parseIso(""), null);
});