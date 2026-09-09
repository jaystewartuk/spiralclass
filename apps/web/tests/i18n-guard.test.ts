import { describe, expect, it } from "vitest";
// The scanner lives in scripts/ (plain ESM, outside src/) so it stays out of
// the coverage denominator; the test drives it here.
import { collectCounts, loadBaseline, scanSource } from "../scripts/i18n-guard.mjs";

// Ratchet guard: hardcoded user-facing strings that bypass the shared i18n
// catalog may not GROW. The baseline (scripts/i18n-guard.baseline.json)
// snapshots the current, mid-migration offenders; new or edited files may not
// add literals beyond it, and migrated files (absent from the baseline) must
// stay clean. Regenerate after migrating a surface:
//   node scripts/i18n-guard.mjs --generate
describe("i18n hardcoded-string ratchet", () => {
  const baseline: Record<string, number> = loadBaseline();
  const current: Record<string, number> = collectCounts();

  it("adds no new files with hardcoded user-facing strings", () => {
    const newOffenders = Object.keys(current).filter((file) => !(file in baseline));
    expect(
      newOffenders,
      `New hardcoded user-facing strings found. Use t("key") from the shared ` +
        `catalog (packages/shared/src/i18n) instead:\n${newOffenders.join("\n")}`,
    ).toEqual([]);
  });

  it("does not increase the count in any baselined file", () => {
    const regressions = Object.keys(current)
      .filter((file) => file in baseline && current[file] > baseline[file])
      .map((file) => `${file}: ${baseline[file]} → ${current[file]}`);
    expect(
      regressions,
      `Files added hardcoded user-facing strings beyond their baseline:\n${regressions.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the migrated auth forms free of hardcoded strings", () => {
    // The beachhead surfaces — a direct assertion so a regression here is
    // obvious even if the baseline is regenerated carelessly.
    for (const file of [
      "app/(auth)/sign-in/sign-in-form.tsx",
      "app/(auth)/sign-up/sign-up-form.tsx",
    ]) {
      expect(current[file] ?? 0, `${file} must use the catalog, not inline copy`).toBe(0);
    }
  });

  it("detects JSX text and user-facing attribute literals", () => {
    const src = `export const A = () => <p title="Hola">Adiós {x} 123</p>;`;
    // One JSX text with letters ("Adiós") + one title attribute literal.
    expect(scanSource("a.tsx", src)).toBe(2);
    // Interpolation, numbers and punctuation alone are not user-facing copy.
    expect(scanSource("b.tsx", `export const B = () => <p>{label} — 42</p>;`)).toBe(0);
  });
});
