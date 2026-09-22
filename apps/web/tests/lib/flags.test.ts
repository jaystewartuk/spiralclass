import { afterEach, describe, expect, it } from "vitest";
import { flagEnabled } from "@/lib/flags";

const KEY = "FLAG_TEST_ONLY";

afterEach(() => {
  delete process.env[KEY];
});

describe("flagEnabled", () => {
  it("is off when unset", () => {
    expect(flagEnabled(KEY)).toBe(false);
  });

  it.each(["1", "true", "TRUE", "on", "On", " true "])("is on for %j", (v) => {
    process.env[KEY] = v;
    expect(flagEnabled(KEY)).toBe(true);
  });

  it.each(["0", "false", "off", "", "yes", "enabled"])("is off for %j", (v) => {
    process.env[KEY] = v;
    expect(flagEnabled(KEY)).toBe(false);
  });
});
