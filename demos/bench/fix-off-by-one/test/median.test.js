import { test } from "node:test";
import assert from "node:assert/strict";
import { median } from "../src/median.js";

test("median of odd list", () => {
  assert.equal(median([3, 1, 7, 5, 9]), 5);
});

test("median of even list averages the two middle values", () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
});