import { describe, expect, it } from "vitest";
import {
  hasFieldErrors,
  isMaterialDraftDirty,
  materialSaveStatus,
  validateManualPackageFields,
  validateMaterialFields,
  zodFieldErrors,
  type MaterialDraftSnapshot,
} from "./form-validation";

describe("validateManualPackageFields", () => {
  it("flags both fields as required when empty", () => {
    const errors = validateManualPackageFields({ classesTotal: "", classesRemaining: "" });
    expect(errors.classesTotal).toBe("required");
    expect(errors.classesRemaining).toBe("required");
    expect(hasFieldErrors(errors)).toBe(true);
  });

  it("rejects a non-numeric or zero total", () => {
    expect(
      validateManualPackageFields({ classesTotal: "abc", classesRemaining: "1" }).classesTotal,
    ).toBe("invalid-number");
    expect(
      validateManualPackageFields({ classesTotal: "0", classesRemaining: "0" }).classesTotal,
    ).toBe("invalid-number");
  });

  it("rejects a negative or non-numeric remaining count", () => {
    expect(
      validateManualPackageFields({ classesTotal: "10", classesRemaining: "-1" }).classesRemaining,
    ).toBe("invalid-number");
  });

  it("rejects remaining greater than total", () => {
    const errors = validateManualPackageFields({ classesTotal: "5", classesRemaining: "6" });
    expect(errors.classesRemaining).toBe("remaining-gt-total");
    expect(errors.classesTotal).toBeUndefined();
  });

  it("rejects remaining greater than maxRemaining even when under total", () => {
    const errors = validateManualPackageFields({
      classesTotal: "10",
      classesRemaining: "8",
      maxRemaining: 6,
    });
    expect(errors.classesRemaining).toBe("remaining-gt-max");
  });

  it("does not double-flag remaining when total is already invalid", () => {
    const errors = validateManualPackageFields({ classesTotal: "", classesRemaining: "6" });
    expect(errors.classesRemaining).toBeUndefined();
  });

  it("accepts a valid total/remaining pair", () => {
    const errors = validateManualPackageFields({
      classesTotal: "10",
      classesRemaining: "4",
      maxRemaining: 9,
    });
    expect(hasFieldErrors(errors)).toBe(false);
  });
});

describe("validateMaterialFields", () => {
  const empty = { levelId: "", hasBody: false, hasFile: false, linkUrl: "" };

  it("flags a missing level and missing content when the form is empty", () => {
    const errors = validateMaterialFields(empty);
    expect(errors.level).toBe("required");
    expect(errors.content).toBe("required");
    expect(hasFieldErrors(errors)).toBe(true);
  });

  it("does not require a level in booking scope", () => {
    const errors = validateMaterialFields({ ...empty, requireLevel: false, hasBody: true });
    expect(errors.level).toBeUndefined();
    expect(hasFieldErrors(errors)).toBe(false);
  });

  it("clears the content error when any single piece is present", () => {
    expect(
      validateMaterialFields({ ...empty, levelId: "l1", hasBody: true }).content,
    ).toBeUndefined();
    expect(
      validateMaterialFields({ ...empty, levelId: "l1", hasFile: true }).content,
    ).toBeUndefined();
    expect(
      validateMaterialFields({ ...empty, levelId: "l1", linkUrl: "https://a.com" }).content,
    ).toBeUndefined();
  });

  it("treats a whitespace-only body/link as absent", () => {
    const errors = validateMaterialFields({
      levelId: "l1",
      hasBody: false,
      hasFile: false,
      linkUrl: "   ",
    });
    expect(errors.content).toBe("required");
  });

  it("rejects a malformed link but not a valid one", () => {
    expect(validateMaterialFields({ ...empty, levelId: "l1", linkUrl: "not a url" }).linkUrl).toBe(
      "invalid-url",
    );
    expect(
      validateMaterialFields({ ...empty, levelId: "l1", linkUrl: "https://example.com/a" }).linkUrl,
    ).toBeUndefined();
  });

  it("is clean when a level and a valid link are both present", () => {
    const errors = validateMaterialFields({
      levelId: "l1",
      hasBody: false,
      hasFile: false,
      linkUrl: "https://example.com",
    });
    expect(hasFieldErrors(errors)).toBe(false);
  });
});

describe("isMaterialDraftDirty", () => {
  const saved: MaterialDraftSnapshot = {
    body: "# Body",
    source: "ai",
    label: "Lesson 1",
    levelId: "l1",
    visibility: "at_or_below",
    focusTagIds: ["t1", "t2"],
    linkUrl: "https://example.com",
  };

  it("is clean when the two snapshots are identical", () => {
    expect(isMaterialDraftDirty({ ...saved }, saved)).toBe(false);
  });

  it.each([
    ["body", { body: "# Changed" }],
    ["source", { source: "manual" }],
    ["label", { label: "Lesson 2" }],
    ["levelId", { levelId: "l2" }],
    ["visibility", { visibility: "exact" }],
    ["linkUrl", { linkUrl: "https://other.com" }],
  ] as const)("is dirty on a %s-only change", (_field, patch) => {
    expect(isMaterialDraftDirty({ ...saved, ...patch }, saved)).toBe(true);
  });

  it("is dirty on a tag add and on a tag remove", () => {
    expect(isMaterialDraftDirty({ ...saved, focusTagIds: ["t1", "t2", "t3"] }, saved)).toBe(true);
    expect(isMaterialDraftDirty({ ...saved, focusTagIds: ["t1"] }, saved)).toBe(true);
  });

  it("is clean on a tag reorder (selection, not order, is what saves)", () => {
    expect(isMaterialDraftDirty({ ...saved, focusTagIds: ["t2", "t1"] }, saved)).toBe(false);
  });

  it("treats undefined and empty as equal for every optional field", () => {
    const minimal: MaterialDraftSnapshot = { body: "x", source: "manual" };
    const explicit: MaterialDraftSnapshot = {
      body: "x",
      source: "manual",
      label: "",
      levelId: "",
      visibility: "",
      focusTagIds: [],
      linkUrl: "",
    };
    expect(isMaterialDraftDirty(explicit, minimal)).toBe(false);
    expect(isMaterialDraftDirty(minimal, explicit)).toBe(false);
  });
});

describe("materialSaveStatus", () => {
  it("prioritizes saving over everything", () => {
    expect(materialSaveStatus({ saving: true, dirty: true, savedOk: true })).toBe("saving");
  });

  it("lets dirty beat a stale savedOk — the 'Saved next to edits' regression", () => {
    expect(materialSaveStatus({ saving: false, dirty: true, savedOk: true })).toBe("dirty");
  });

  it("shows saved only when clean", () => {
    expect(materialSaveStatus({ saving: false, dirty: false, savedOk: true })).toBe("saved");
    expect(materialSaveStatus({ saving: false, dirty: false, savedOk: false })).toBe("idle");
  });
});

describe("zodFieldErrors", () => {
  it("keeps the first message per top-level field and collapses nested paths", () => {
    const out = zodFieldErrors({
      issues: [
        { path: ["email"], message: "Invalid email" },
        { path: ["email"], message: "second email issue" },
        { path: ["ranges", 0, "endTime"], message: "End must be after start" },
      ],
    });
    expect(out).toEqual({
      email: "Invalid email",
      ranges: "End must be after start",
    });
  });

  it("ignores issues with an empty path (form-level refinements)", () => {
    const out = zodFieldErrors({ issues: [{ path: [], message: "form-level" }] });
    expect(out).toEqual({});
  });
});
