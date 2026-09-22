import { describe, expect, it } from "vitest";
import {
  PACKAGE_NAME_MAX_CHARS,
  deriveWiseAuto,
  duplicatePackageName,
  packageRowIssue,
  packageRowIssues,
  pendingPackageChanges,
  pricePerClassMinorUnits,
  transferPriceIsNotADiscount,
  type PackageDraft,
  type PackageRow,
} from "@/lib/pricing/package-editor";
import { computeWisePriceFromStripe } from "@spiralclass/shared";

// The package editor's view-model. These are the rules the collapsed row
// summary, the unsaved-changes bar and the pre-submit validation all read, so
// they are asserted here rather than inferred from rendered markup.

const DRAFT: PackageDraft = {
  id: "tpl-1",
  name: "8 classes / 2 months",
  subject: null,
  classCount: 8,
  singleClass: false,
  classDurationMin: 50,
  priceMinorUnits: 240_000,
  transferPriceMinorUnits: null,
  expirationMonths: 2,
};

const row = (patch: Partial<PackageRow> = {}): PackageRow => ({
  ...DRAFT,
  localKey: DRAFT.id,
  keep: true,
  wiseAuto: false,
  ...patch,
});

describe("packageRowIssue — mirrors packageTemplateSchema, no stricter", () => {
  it("accepts a complete row", () => {
    expect(packageRowIssue(row())).toBeNull();
  });

  it("reports a missing name, whitespace included", () => {
    expect(packageRowIssue(row({ name: "" }))).toBe("name-missing");
    expect(packageRowIssue(row({ name: "   " }))).toBe("name-missing");
  });

  it("reports a class count below one, and a blank field (NaN from an empty input)", () => {
    expect(packageRowIssue(row({ classCount: 0 }))).toBe("class-count");
    expect(packageRowIssue(row({ classCount: Number.NaN }))).toBe("class-count");
  });

  it("ignores the class count on a single-class row, which the form pins to 1", () => {
    // The hidden input posts `1` regardless, so blocking the save on a stale
    // count the teacher cannot even see would refuse what the server accepts.
    expect(packageRowIssue(row({ singleClass: true, classCount: 0 }))).toBeNull();
  });

  it("reports a duration below a minute and a missing validity", () => {
    expect(packageRowIssue(row({ classDurationMin: 0 }))).toBe("duration");
    expect(packageRowIssue(row({ expirationMonths: null }))).toBe("expiration-missing");
    expect(packageRowIssue(row({ expirationMonths: 0 }))).toBe("expiration-missing");
  });

  it("allows a free package but not a negative one", () => {
    expect(packageRowIssue(row({ priceMinorUnits: 0 }))).toBeNull();
    expect(packageRowIssue(row({ priceMinorUnits: -1 }))).toBe("price-negative");
  });

  it("never blocks on a removed row — its contents are about to be archived", () => {
    expect(packageRowIssue(row({ keep: false, name: "", expirationMonths: null }))).toBeNull();
  });

  it("collects issues by localKey, skipping the rows that are fine", () => {
    const issues = packageRowIssues([
      row({ localKey: "a" }),
      row({ localKey: "b", name: "" }),
      row({ localKey: "c", classDurationMin: 0 }),
    ]);
    expect([...issues.entries()]).toEqual([
      ["b", "name-missing"],
      ["c", "duration"],
    ]);
  });
});

describe("transferPriceIsNotADiscount", () => {
  it("flags a transfer price at or above the card price", () => {
    expect(transferPriceIsNotADiscount(row({ transferPriceMinorUnits: 240_000 }))).toBe(true);
    expect(transferPriceIsNotADiscount(row({ transferPriceMinorUnits: 250_000 }))).toBe(true);
  });

  it("stays quiet for a real discount, and when there is no transfer price at all", () => {
    expect(transferPriceIsNotADiscount(row({ transferPriceMinorUnits: 230_000 }))).toBe(false);
    expect(transferPriceIsNotADiscount(row({ transferPriceMinorUnits: null }))).toBe(false);
  });

  it("stays quiet on a free package, where 0 >= 0 is not a pricing mistake", () => {
    expect(
      transferPriceIsNotADiscount(row({ priceMinorUnits: 0, transferPriceMinorUnits: 0 })),
    ).toBe(false);
  });
});

describe("pricePerClassMinorUnits", () => {
  it("divides the package price across its classes", () => {
    expect(pricePerClassMinorUnits(row())).toBe(30_000);
  });

  it("rounds to the nearest minor unit rather than truncating", () => {
    expect(pricePerClassMinorUnits(row({ classCount: 3, priceMinorUnits: 10_000 }))).toBe(3_333);
  });

  it("says nothing where it would be noise: one class, no price, a broken count", () => {
    expect(pricePerClassMinorUnits(row({ singleClass: true, classCount: 1 }))).toBeNull();
    expect(pricePerClassMinorUnits(row({ classCount: 1 }))).toBeNull();
    expect(pricePerClassMinorUnits(row({ priceMinorUnits: 0 }))).toBeNull();
    expect(pricePerClassMinorUnits(row({ classCount: Number.NaN }))).toBeNull();
  });
});

describe("pendingPackageChanges", () => {
  it("is quiet when nothing has moved", () => {
    expect(pendingPackageChanges([DRAFT], [row()])).toMatchObject({ count: 0, dirty: false });
  });

  it("counts an edit to any priced or structural field", () => {
    for (const patch of [
      { name: "renamed" },
      { classCount: 10 },
      { classDurationMin: 60 },
      { priceMinorUnits: 250_000 },
      { transferPriceMinorUnits: 230_000 },
      { expirationMonths: 3 },
      { subject: "Conversation" },
      { singleClass: true },
    ] as Array<Partial<PackageRow>>) {
      expect(pendingPackageChanges([DRAFT], [row(patch)])).toMatchObject({
        edited: 1,
        dirty: true,
      });
    }
  });

  it("does not count a subject that only gained whitespace, or a re-derived wiseAuto flag", () => {
    expect(pendingPackageChanges([DRAFT], [row({ subject: "  " })])).toMatchObject({ count: 0 });
    expect(pendingPackageChanges([DRAFT], [row({ wiseAuto: true })])).toMatchObject({ count: 0 });
  });

  it("counts an added row, a removed row, and neither for one added then removed", () => {
    const added = row({ id: "", localKey: "new-1" });
    expect(pendingPackageChanges([DRAFT], [row(), added])).toMatchObject({ added: 1, count: 1 });
    expect(pendingPackageChanges([DRAFT], [row({ keep: false })])).toMatchObject({
      removed: 1,
      count: 1,
    });
    expect(pendingPackageChanges([DRAFT], [row(), { ...added, keep: false }])).toMatchObject({
      count: 0,
      dirty: false,
    });
  });

  it("ignores an id the server never confirmed", () => {
    // A stale row left over from a failed save is not something this summary
    // can speak for either way.
    expect(pendingPackageChanges([DRAFT], [row({ id: "ghost", localKey: "ghost" })])).toMatchObject(
      { count: 0 },
    );
  });
});

describe("deriveWiseAuto", () => {
  it("recognises a transfer price still equal to the computed one, per currency", () => {
    const auto = computeWisePriceFromStripe(240_000, "MXN");
    expect(deriveWiseAuto(240_000, auto, "MXN")).toBe(true);
    expect(deriveWiseAuto(240_000, auto - 100, "MXN")).toBe(false);
    expect(deriveWiseAuto(240_000, null, "MXN")).toBe(false);
  });

  it("answers per currency — a 0-decimal currency computes a different figure", () => {
    const jpy = computeWisePriceFromStripe(1_500, "JPY");
    expect(deriveWiseAuto(1_500, jpy, "JPY")).toBe(true);
    // The same minor-unit amount read as MXN derives a different auto price,
    // which is the whole reason the currency is a required argument.
    expect(deriveWiseAuto(1_500, jpy, "MXN")).toBe(
      computeWisePriceFromStripe(1_500, "MXN") === jpy,
    );
  });
});

describe("duplicatePackageName", () => {
  it("numbers the copy, and increments rather than nesting suffixes", () => {
    expect(duplicatePackageName("8 classes", ["8 classes"])).toBe("8 classes (2)");
    expect(duplicatePackageName("8 classes (2)", ["8 classes", "8 classes (2)"])).toBe(
      "8 classes (3)",
    );
  });

  it("matches case-insensitively, so a copy never collides with an existing name", () => {
    expect(duplicatePackageName("8 Classes", ["8 classes (2)"])).toBe("8 Classes (3)");
  });

  it("clamps to the column limit so the shown name is the stored name", () => {
    const long = "x".repeat(PACKAGE_NAME_MAX_CHARS);
    expect(duplicatePackageName(long, [long]).length).toBeLessThanOrEqual(PACKAGE_NAME_MAX_CHARS);
  });
});
