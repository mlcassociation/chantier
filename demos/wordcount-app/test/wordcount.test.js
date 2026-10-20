import { test } from "node:test";
import assert from "node:assert/strict";
import { wordcount } from "../src/wordcount.js";

test("counts words", () => {
  assert.equal(wordcount("one two  three"), 3);
});

test("counts unique words", () => {
  assert.equal(wordcount("a a b", { unique: true }), 2);
});
