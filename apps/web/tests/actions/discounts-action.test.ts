import { beforeEach, describe, expect, it, vi } from "vitest";
import { createT } from "@spiralclass/shared";

// createDiscountCode is the teacher-facing form action behind the promo-code
// primitive. This pins that a freshly created code is stamped currency=MXN
// (prep for future multi-currency support — see schema.prisma DiscountCode).

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: vi.fn(async () => "es-MX"),
  getT: vi.fn(async () => createT("es-MX")),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const state: { created: Record<string, unknown> | null } = { created: null };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    discountCode: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.created = data;
        return { id: "dc1", ...data };
      }),
    },
    // createDiscountCode resolves the teacher's settlement currency. MX → MXN.
    teacher: { findUnique: async () => ({ platformRegion: "MX" }) },
  },
}));

const { createDiscountCode } = await import("@/app/actions/discounts");

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("createDiscountCode", () => {
  beforeEach(() => {
    state.created = null;
  });

  it("stamps a new fixed-amount code with currency MXN", async () => {
    const result = await createDiscountCode(
      undefined,
      form({
        code: "PROMO10",
        kind: "fixed",
        amountPesos: "100",
        // The client only renders one of percent/amountPesos depending on
        // `kind`, but the schema validates both fields unconditionally
        // (pre-existing behavior, unrelated to this change) — supply both
        // so the unused one doesn't trip an unrelated validation error.
        percent: "10",
        maxRedemptions: "",
        perStudentLimit: "1",
        expiresAt: "",
      }),
    );
    expect(result).toEqual({ ok: true, code: "PROMO10" });
    expect(state.created).toMatchObject({
      code: "PROMO10",
      currency: "MXN",
    });
  });
});
