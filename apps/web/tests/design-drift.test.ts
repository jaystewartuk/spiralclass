import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The scanner lives in scripts/ (plain ESM, outside src/) so it stays out of
// the coverage denominator; the test drives it here — the same arrangement as
// tests/i18n-guard.test.ts.
import {
  CATEGORIES,
  collectCounts,
  loadBaseline,
  scanSource,
  totals,
} from "../scripts/design-drift.mjs";

type Counts = Record<string, Record<string, number>>;

// Ratchet guard: components that bypass the design tokens may not GROW. The
// baseline (scripts/design-drift.baseline.json) snapshots the drift as it
// stood when the re-architecture began; new or edited files may not add
// bypasses beyond it, and a file migrated to zero is protected from
// regressing. Regenerate after migrating a surface:
//   node scripts/design-drift.mjs --generate
describe("design-token drift ratchet", () => {
  const baseline: Counts = loadBaseline();
  // Scanned ONCE, here, and reused by every assertion below. Two of them used
  // to call collectCounts() again inside the `it` body, which walks the whole
  // source tree a second and third time. On the laptop that is ~1s a scan and
  // invisible; on a four-core runner sharing itself with the rest of a 7,600-
  // test parallel suite it is over vitest's 20s per-test timeout, and the gate
  // went red on two tests that had found nothing wrong. Nothing between these
  // assertions writes source, so a rescan could only ever return this.
  const current: Counts = collectCounts();

  it("adds no new files that bypass the token layer", () => {
    const newOffenders = Object.keys(current)
      .filter((file) => !(file in baseline))
      .map((file) => `${file}: ${Object.keys(current[file]).join(", ")}`);
    expect(
      newOffenders,
      `New design-token bypasses found. Use the semantic tokens and the ui/ ` +
        `primitives rather than raw values:\n${newOffenders.join("\n")}`,
    ).toEqual([]);
  });

  it("does not increase any category count in a baselined file", () => {
    const regressions: string[] = [];
    for (const [file, cats] of Object.entries(current)) {
      if (!(file in baseline)) continue;
      for (const [category, n] of Object.entries(cats)) {
        const was = baseline[file][category] ?? 0;
        if (n > was) {
          const remedy = CATEGORIES[category as keyof typeof CATEGORIES]?.remedy ?? "";
          regressions.push(`${file} — ${category}: ${was} → ${n}\n    ${remedy}`);
        }
      }
    }
    expect(
      regressions,
      `Files added design-token bypasses beyond their baseline:\n${regressions.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the design-system primitives themselves free of raw values", () => {
    // The seven load-bearing primitives are what every other surface inherits
    // from. A raw value here propagates to 440 files, so these are asserted
    // directly rather than left to the baseline, where a careless regeneration
    // could silently bless them.
    for (const file of [
      "components/ui/button.tsx",
      "components/ui/card.tsx",
      "components/ui/input.tsx",
      "components/ui/badge.tsx",
      "components/ui/alert.tsx",
      "components/ui/skeleton.tsx",
      "components/ui/form-status.tsx",
    ]) {
      const found = current[file] ?? {};
      const offending = Object.entries(found).filter(([category]) => category !== "arbitraryValue");
      expect(
        Object.fromEntries(offending),
        `${file} is a primitive — it must consume tokens, not raw values`,
      ).toEqual({});
    }
  });

  it("has no raw Tailwind palette utilities left anywhere", () => {
    // The headline defect of the whole exercise: 119 of these existed, none of
    // them with a `dark:` counterpart, so every one rendered light-on-light in
    // dark mode. The category is now empty, and empty is a state worth
    // asserting directly — the per-file ratchet only stops a file GROWING, so
    // it would happily accept a brand new file full of them.
    const offenders = Object.entries(current)
      .filter(([, cats]) => cats.rawPalette)
      .map(([file, cats]) => `${file}: ${cats.rawPalette}`);
    expect(
      offenders,
      `Raw palette utilities are back. They have no dark: counterpart. Use a ` +
        `semantic utility or a Badge/Alert variant:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("sizes text in rem, so the browser's own font-size setting still works", () => {
    // A px font size ignores the reader's browser setting entirely. That
    // setting is the single most effective accessibility control there is —
    // it is set once and applies to every site — so breaking it costs more
    // than any in-app control can give back. 48 of these existed before
    // D-140; the ratchet keeps them at zero.
    const offenders: string[] = [];
    for (const [file, cats] of Object.entries(current)) {
      void cats;
      const source = readFileSync(resolve(__dirname, "../src", file), "utf8");
      const hits = source.match(/text-\[[0-9.]+px\]/g);
      if (hits) offenders.push(`${file}: ${hits.join(", ")}`);
    }
    expect(
      offenders,
      `Text sized in px ignores the reader's browser font-size setting. Use a ` +
        `scale step, or rem if none fits:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a total, so the before/after is measurable rather than claimed", () => {
    const t = totals(current);
    const sum = Object.values(t).reduce((a, b) => a + b, 0);
    // Not an assertion about the number — an assertion that the number exists
    // and is finite, so a broken scanner fails loudly instead of reporting 0.
    expect(sum).toBeGreaterThan(0);
    expect(Object.keys(t).sort()).toEqual(Object.keys(CATEGORIES).sort());
  });

  describe("detectors", () => {
    it("counts raw hex colours but not route anchors or hex-like paths", () => {
      expect(scanSource("a.tsx", `const c = "#B7472D";`).rawHex).toBe(1);
      expect(scanSource("a.tsx", `const c = "#fff";`).rawHex).toBe(1);
      expect(scanSource("a.tsx", `<a href="#123">x</a>`).rawHex ?? 0).toBe(0);
      expect(scanSource("a.tsx", `<a href="/docs#section">x</a>`).rawHex ?? 0).toBe(0);
    });

    it("counts literal colour functions but not hsl(var(--token))", () => {
      expect(scanSource("a.tsx", `color: "rgba(31, 19, 15, 0.8)"`).rawColorFn).toBe(1);
      expect(scanSource("a.tsx", `background: "hsl(var(--primary))"`).rawColorFn ?? 0).toBe(0);
    });

    it("counts stock palette utilities but not semantic ones", () => {
      expect(scanSource("a.tsx", `className="bg-emerald-100 text-emerald-900"`).rawPalette).toBe(2);
      expect(scanSource("a.tsx", `className="dark:bg-violet-950"`).rawPalette).toBe(1);
      expect(
        scanSource("a.tsx", `className="bg-muted text-muted-foreground"`).rawPalette ?? 0,
      ).toBe(0);
      expect(scanSource("a.tsx", `className="bg-primary text-clay"`).rawPalette ?? 0).toBe(0);
    });

    it("counts arbitrary values but not Radix or ARIA state variants", () => {
      expect(scanSource("a.tsx", `className="text-[11px] min-w-[16rem]"`).arbitraryValue).toBe(2);
      expect(
        scanSource("a.tsx", `className="data-[state=open]:bg-muted"`).arbitraryValue ?? 0,
      ).toBe(0);
      expect(
        scanSource("a.tsx", `className="supports-[backdrop-filter]:bg-white"`).arbitraryValue ?? 0,
      ).toBe(0);
    });

    it("counts raw <button> but not the <Button> primitive", () => {
      expect(scanSource("a.tsx", `<button onClick={x}>Go</button>`).rawButton).toBe(1);
      expect(scanSource("a.tsx", `<Button onClick={x}>Go</Button>`).rawButton ?? 0).toBe(0);
    });

    it("counts ad-hoc scrim opacities", () => {
      expect(scanSource("a.tsx", `className="bg-white/15 text-black/60"`).scrimOpacity).toBe(2);
      expect(scanSource("a.tsx", `className="bg-white text-black"`).scrimOpacity ?? 0).toBe(0);
    });

    it("ignores bypasses inside comments", () => {
      expect(scanSource("a.tsx", `// const c = "#B7472D";`).rawHex ?? 0).toBe(0);
      expect(scanSource("a.tsx", `/* bg-emerald-100 */`).rawPalette ?? 0).toBe(0);
    });

    it("honours the allowlist", () => {
      const google = `const c = "#4285F4";`;
      expect(scanSource("app/(auth)/google-sign-in-button.tsx", google).rawHex ?? 0).toBe(0);
      expect(scanSource("elsewhere.tsx", google).rawHex).toBe(1);
    });
  });
});
