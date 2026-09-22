import { beforeEach, describe, expect, it, vi } from "vitest";
import { createT, type AppLocale } from "@spiralclass/shared";

// createDiscountCode's parsing of the FormData the Discounts form actually
// sends. The core create is covered in tests/lib/discounts-manage.test.ts; the
// form's own submission was not, and the same defect fixed in
// saveReferralProgram made every code creation fail here too — the form renders
// the percent input OR the pesos input, so the other name is absent and
// z.coerce.number() turned that null into a 0 that failed positive()/min(1).

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

// The action resolves its messages through the real catalog now (it used to
// branch on `locale === "en"`, which quietly served French teachers Spanish),
// so the mock supplies a real `t` rather than a locale tag. The assertions
// below are therefore against published copy, not test fixtures.
const locale = { current: "en" as AppLocale };
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: vi.fn(async () => locale.current),
  getT: vi.fn(async () => createT(locale.current)),
}));

const createDiscountCodeCore = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/discounts/manage", () => ({
  createDiscountCode: createDiscountCodeCore,
  deleteDiscountCode: vi.fn(),
  setDiscountCodeActive: vi.fn(),
}));

const { createDiscountCode } = await import("@/app/actions/discounts");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  locale.current = "en";
});

describe("createDiscountCode", () => {
  it("creates a percent code — the pesos field is simply not in the form", async () => {
    const res = await createDiscountCode(
      undefined,
      fd({
        code: "AMIGO-TAL",
        kind: "percent",
        percent: "15",
        perStudentLimit: "1",
        maxRedemptions: "1",
        expiresAt: "2026-09-29",
      }),
    );

    expect(res).toEqual({ ok: true, code: "AMIGO-TAL" });
    expect(createDiscountCodeCore).toHaveBeenCalledWith("t1", {
      code: "AMIGO-TAL",
      kind: "percent",
      percent: 15,
      amountPesos: undefined,
      maxRedemptions: 1,
      perStudentLimit: 1,
      expiresAt: "2026-09-29",
    });
  });

  it("creates a fixed code — the percent field is the one absent", async () => {
    const res = await createDiscountCode(
      undefined,
      fd({
        code: "VUELVE100",
        kind: "fixed",
        amountPesos: "100",
        perStudentLimit: "1",
        maxRedemptions: "",
        expiresAt: "",
      }),
    );

    expect(res).toEqual({ ok: true, code: "VUELVE100" });
    expect(createDiscountCodeCore).toHaveBeenCalledWith("t1", {
      code: "VUELVE100",
      kind: "fixed",
      percent: undefined,
      amountPesos: 100,
      maxRedemptions: null,
      perStudentLimit: 1,
      expiresAt: null,
    });
  });

  it("defaults the per-student limit to 1 when the field is left blank", async () => {
    await createDiscountCode(
      undefined,
      fd({ code: "AMIGO-REJ", kind: "percent", percent: "15", perStudentLimit: "" }),
    );

    expect(createDiscountCodeCore).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ perStudentLimit: 1 }),
    );
  });

  it("still rejects a discount value left blank", async () => {
    const res = await createDiscountCode(
      undefined,
      fd({ code: "AMIGO-YUVI", kind: "percent", percent: "", perStudentLimit: "1" }),
    );

    expect(res).toEqual({ error: "Enter the discount value.", field: "value" });
    expect(createDiscountCodeCore).not.toHaveBeenCalled();
  });

  it("still rejects a code that is too short", async () => {
    const res = await createDiscountCode(
      undefined,
      fd({ code: "AB", kind: "percent", percent: "15", perStudentLimit: "1" }),
    );

    expect(res).toEqual({ error: "Give the code at least 3 characters.", field: "code" });
    expect(createDiscountCodeCore).not.toHaveBeenCalled();
  });

  it("still rejects a code with characters other than letters, numbers and hyphens", async () => {
    const res = await createDiscountCode(
      undefined,
      fd({ code: "AMIGO TAL!", kind: "percent", percent: "15", perStudentLimit: "1" }),
    );

    expect(res).toEqual({ error: "Letters, numbers and hyphens only.", field: "code" });
    expect(createDiscountCodeCore).not.toHaveBeenCalled();
  });

  it("reports a duplicate name rather than throwing", async () => {
    createDiscountCodeCore.mockResolvedValueOnce({ ok: false } as never);

    const res = await createDiscountCode(
      undefined,
      fd({ code: "AMIGO-TAL", kind: "percent", percent: "15", perStudentLimit: "1" }),
    );

    expect(res).toEqual({ error: "You already have a code with that name.", field: "code" });
  });

  it("refuses an expiry that has already passed", async () => {
    // A past date created a code that was dead the moment it existed: the
    // checkout refused it and the dashboard (correctly, uselessly) showed it as
    // expired. Nothing checked, because expiry was only ever a format regex.
    const res = await createDiscountCode(
      undefined,
      fd({
        code: "AYER",
        kind: "percent",
        percent: "15",
        perStudentLimit: "1",
        expiresAt: "2020-01-01",
      }),
    );

    expect(res).toEqual({ error: "Pick a date that has not passed yet.", field: "expiresAt" });
    expect(createDiscountCodeCore).not.toHaveBeenCalled();
  });

  it("accepts today, which is a working day until the end of it", async () => {
    // Expiry is stored as end-of-day UTC, so "today" is still in the future.
    const today = new Date().toISOString().slice(0, 10);
    const res = await createDiscountCode(
      undefined,
      fd({ code: "HOY", kind: "percent", percent: "15", perStudentLimit: "1", expiresAt: today }),
    );

    expect(res).toEqual({ ok: true, code: "HOY" });
  });

  it("normalizes the created code for the confirmation, as the database will", async () => {
    const res = await createDiscountCode(
      undefined,
      fd({ code: "verano25", kind: "percent", percent: "15", perStudentLimit: "1" }),
    );

    expect(res).toEqual({ ok: true, code: "VERANO25" });
  });

  it("speaks French to a French teacher", async () => {
    // The regression this pins: every message here was `en ? english : spanish`,
    // so the third locale silently got the second one's copy.
    locale.current = "fr";

    const res = await createDiscountCode(
      undefined,
      fd({ code: "AB", kind: "percent", percent: "15", perStudentLimit: "1" }),
    );

    expect(res).toEqual({
      error: "Le code doit contenir au moins 3 caractères.",
      field: "code",
    });
  });
});
