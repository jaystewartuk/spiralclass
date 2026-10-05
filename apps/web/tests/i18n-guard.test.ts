import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The scanner lives in scripts/ (plain ESM, outside src/) so it stays out of
// the coverage denominator; the test drives it here.
import { EXEMPT, WEB_SRC, collectViolations, scanSource } from "../scripts/i18n-guard.mjs";

// No user-facing copy outside the shared catalog. This was a ratchet against a
// baseline while the web copy was migrated; the baseline reached zero (#178
// step A5), so it is a ban: one literal fails, and there is no baseline to
// raise. A string that is not copy has a home that says so — a constant for a
// name (BRAND_NAME), <code> for an identifier, or an EXEMPT entry with its
// reason.
describe("no hardcoded user-facing strings", () => {
  it("finds none outside the catalog", () => {
    const violations = collectViolations();
    expect(
      violations,
      `Hardcoded user-facing strings found. Use t("key") from the shared catalog ` +
        `(packages/shared/src/i18n) instead:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("exempts only files that exist, each with a stated reason", () => {
    for (const [path, reason] of Object.entries(EXEMPT)) {
      expect(existsSync(join(WEB_SRC, path)), path).toBe(true);
      expect(reason.length, path).toBeGreaterThan(40);
    }
  });
});

describe("what the scanner counts", () => {
  it("counts JSX text and user-facing attribute literals", () => {
    const src = `export const A = () => <p title="Hola">Adiós {x} 123</p>;`;
    expect(scanSource("a.tsx", src)).toBe(2);
    // Interpolation, numbers and punctuation alone are not user-facing copy.
    expect(scanSource("b.tsx", `export const B = () => <p>{label} — 42</p>;`)).toBe(0);
  });

  // The case the ratchet could not see: a Google sign-in button said
  // "Continuar con Google" to every reader from inside a ternary.
  it("counts literals inside a {…} child, in either arm or as a fallback", () => {
    expect(
      scanSource("c.tsx", `export const C = () => <b>{p ? "Conectando…" : "Continuar"}</b>;`),
    ).toBe(2);
    expect(
      scanSource("d.tsx", `export const D = () => <b>{x && "shown"}{y ?? "fallback"}</b>;`),
    ).toBe(2);
    expect(scanSource("e.tsx", "export const E = () => <b>{`${n}s`}</b>;")).toBe(1);
    expect(scanSource("f.tsx", `export const F = () => <b>{t("key")}{n}</b>;`)).toBe(0);
  });

  it("leaves identifiers in <code>, <kbd> and <samp> alone", () => {
    expect(
      scanSource("g.tsx", `export const G = () => <p><code>NODE_ENV</code>: <kbd>Ctrl</kbd></p>;`),
    ).toBe(0);
    expect(scanSource("h.tsx", `export const H = () => <p><code>{"APP_URL"}</code></p>;`)).toBe(0);
  });
});
