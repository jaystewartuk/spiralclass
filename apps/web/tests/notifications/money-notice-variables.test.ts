import { describe, expect, it, vi } from "vitest";
import { buildVariables, type BuildContext } from "@/lib/notifications/dispatcher";
import type { PrismaClient } from "@prisma/client";

// The money-of-record notices — payment received, payment failed, refund
// issued, Wise marked sent — render an AMOUNT and a PACKAGE NAME into copy
// that exists in both Spanish and English. Two things used to be wrong with
// how those two variables were built, and both reached real recipients:
//
//   1. The amount was formatted with no currency, so it fell through to
//      `formatMinorUnits`'s MXN default. A teacher pricing in GBP, EUR or COP
//      sent her students receipts and refund notices denominated in pesos.
//      `Payment.currency` records the real one; these now read it.
//   2. The package-name fallback (for a template deleted since the purchase)
//      was the hardcoded Spanish "tu paquete", interpolated into the English
//      copy as well — "Your refund of £20.00 for tu paquete".

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";

function payment(overrides: { currency?: string; templateName?: string | null } = {}) {
  return {
    id: PAYMENT_ID,
    amountMinorUnits: 2_000,
    currency: overrides.currency ?? "GBP",
    paymentReference: null,
    package: {
      id: "33333333-3333-4333-8333-333333333333",
      template:
        overrides.templateName === null ? null : { name: overrides.templateName ?? "Clase suelta" },
      student: { name: "Jay" },
      teacher: { bookingSlug: "mira" },
    },
  };
}

function prismaWith(row: ReturnType<typeof payment>): PrismaClient {
  return {
    payment: { findFirst: vi.fn(async () => row) },
  } as unknown as PrismaClient;
}

function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    templateName: "refund_issued_student",
    notification: {
      id: "n1",
      teacherId: TEACHER_ID,
      bookingId: null,
      paymentId: PAYMENT_ID,
      metadata: null,
    },
    teacherName: "Alicia Moreno",
    recipientTimezone: "America/Mexico_City",
    recipientLocale: "en",
    storage: null,
    ...overrides,
  } as BuildContext;
}

describe("money-of-record notice variables", () => {
  it("states the payment's own currency, not the MXN default", async () => {
    const res = await buildVariables(prismaWith(payment({ currency: "GBP" })), ctx());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const amount = (res.variables as { amount: string }).amount;
    expect(amount).toContain("GBP");
    expect(amount).not.toContain("MXN");
  });

  it("still renders MXN for a teacher who really does price in pesos", async () => {
    const res = await buildVariables(prismaWith(payment({ currency: "MXN" })), ctx());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.variables as { amount: string }).amount).toContain("MXN");
  });

  it("falls back to an ENGLISH package name for an English reader", async () => {
    const res = await buildVariables(
      prismaWith(payment({ templateName: null })),
      ctx({ recipientLocale: "en" }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.variables as { packageName: string }).packageName).toBe("your package");
  });

  it("keeps the Spanish fallback for an es-MX reader", async () => {
    const res = await buildVariables(
      prismaWith(payment({ templateName: null })),
      ctx({ recipientLocale: "es-MX" }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.variables as { packageName: string }).packageName).toBe("tu paquete");
  });

  // The lost-chargeback pair goes through the same payment join, so it has the
  // same two ways to go wrong.
  it("states the payment's own currency on the lost-chargeback notices too", async () => {
    for (const templateName of ["dispute_lost_student", "dispute_lost_teacher"] as const) {
      const res = await buildVariables(
        prismaWith(payment({ currency: "EUR" })),
        ctx({ templateName }),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect((res.variables as { amount: string }).amount).toContain("EUR");
    }
  });

  it("addresses the lost-chargeback teacher notice to the student by name", async () => {
    const res = await buildVariables(
      prismaWith(payment()),
      ctx({ templateName: "dispute_lost_teacher" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.variables as { studentName: string; paymentPathSuffix: string }).toMatchObject({
      studentName: "Jay",
      paymentPathSuffix: `payments/${PAYMENT_ID}`,
    });
  });

  it("refuses to build a lost-chargeback notice with no payment attached", async () => {
    const res = await buildVariables(
      prismaWith(payment()),
      ctx({
        templateName: "dispute_lost_student",
        notification: {
          id: "n1",
          teacherId: TEACHER_ID,
          bookingId: null,
          paymentId: null,
          metadata: null,
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: "missing-payment-id:dispute_lost_student" });
  });

  it("uses the real template name whenever there is one", async () => {
    const res = await buildVariables(prismaWith(payment({ templateName: "Clase suelta" })), ctx());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.variables as { packageName: string }).packageName).toBe("Clase suelta");
  });
});
