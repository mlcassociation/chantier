import { describe, expect, it } from "vitest";
import { resolveScreenReader } from "../src/screen-reader.ts";

describe("resolveScreenReader", () => {
  it("enables on the --screen-reader flag", () => {
    expect(resolveScreenReader(true, undefined)).toBe(true);
  });

  it("enables on the CHANTIER_SCREEN_READER=1 env alias", () => {
    expect(resolveScreenReader(undefined, "1")).toBe(true);
  });

  it("stays off for strict non-1 values", () => {
    expect(resolveScreenReader(undefined, "0")).toBe(false);
    expect(resolveScreenReader(undefined, "true")).toBe(false);
    expect(resolveScreenReader(undefined, undefined)).toBe(false);
    expect(resolveScreenReader(false, "0")).toBe(false);
  });

  it("lets the flag force mode on even when the env is unset", () => {
    expect(resolveScreenReader(true, "0")).toBe(true);
  });
});
