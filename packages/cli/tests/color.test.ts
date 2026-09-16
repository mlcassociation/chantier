import chalk from "chalk";
import { afterEach, describe, expect, it } from "vitest";
import { disableColors } from "../src/color.ts";

const savedLevel = chalk.level;

describe("disableColors", () => {
  it("forces chalk level 0 on --no-color", () => {
    chalk.level = 3;
    disableColors(true, undefined);
    expect(chalk.level).toBe(0);
  });

  it("forces chalk level 0 on the NO_COLOR env var", () => {
    chalk.level = 3;
    disableColors(undefined, "1");
    expect(chalk.level).toBe(0);
  });

  it("leaves color untouched otherwise", () => {
    chalk.level = 3;
    disableColors(false, undefined);
    expect(chalk.level).toBe(3);
  });

  afterEach(() => {
    chalk.level = savedLevel;
  });
});
