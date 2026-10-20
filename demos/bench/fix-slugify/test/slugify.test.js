import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("basic text", () => {
  assert.equal(slugify("hello world"), "hello-world");
});

test("case and punctuation", () => {
  assert.equal(slugify("Hello,  World!"), "hello-world");
  assert.equal(slugify("  Le Café  "), "le-caf");
});

test("trims edge dashes", () => {
  assert.equal(slugify(" --ok-- "), "ok");
});