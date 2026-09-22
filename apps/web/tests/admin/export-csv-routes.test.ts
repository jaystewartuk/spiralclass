import { describe, expect, it, vi, beforeEach } from "vitest";

// The two finance CSV exports, covered for the first time because D-153
// renamed columns in their HEADER ROW — `net_centavos` → `net_minor_units`,
// `payable_centavos` → `payable_minor_units`, `amount_centavos` →
// `amount_minor_units`. A header is a contract with whatever spreadsheet the
// operator points at it, and nothing asserted these strings, so the rename
// could have shipped a typo (or been silently reverted later) with every
// suite still green.
//
// The header assertions are deliberately exact and positional: a CSV consumer
// keyed on column ORDER breaks just as hard as one keyed on name, and toCsv
// emits them in array order.

const requireAdminMock = vi.fn(async () => {});
const getCommissionReportMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("@/lib/admin", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/subscriptions/admin-metrics", () => ({
  getCommissionReport: getCommissionReportMock,
}));
vi.mock("@/lib/prisma", () => ({ prisma: { payment: { findMany: findManyMock } } }));
vi.mock("@/lib/admin-filters", () => ({ buildPaymentWhere: () => ({}) }));

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue(undefined);
});

describe("GET /api/admin/export/commission", () => {
  it("names the money columns net_minor_units and payable_minor_units", async () => {
    getCommissionReportMock.mockResolvedValue([]);
    const { GET } = await import("@/app/api/admin/export/commission/route");

    const body = await (await GET()).text();

    expect(body.split("\r\n")[0]).toBe(
      "ambassador,referred_teachers,teacher,invoice_id,period_start,net_minor_units,payable_minor_units",
    );
  });

  it("emits a line item then a subtotal per ambassador, both in minor units", async () => {
    getCommissionReportMock.mockResolvedValue([
      {
        ambassador: "Mira",
        referredTeacherCount: 2,
        lineItems: [
          {
            teacherName: "Beto",
            invoiceId: "inv_1",
            periodStart: new Date("2026-03-01T00:00:00.000Z"),
            netMinorUnits: 79_900,
            payableMinorUnits: 39_950,
          },
        ],
        totalNetMinorUnits: 79_900,
        totalPayableMinorUnits: 39_950,
      },
    ]);
    const { GET } = await import("@/app/api/admin/export/commission/route");

    const lines = (await (await GET()).text()).split("\r\n");

    expect(lines[1]).toBe("Mira,2,Beto,inv_1,2026-03-01T00:00:00.000Z,79900,39950");
    // The subtotal row's em-dashed label contains no comma, so it is unquoted.
    expect(lines[2]).toBe("Mira,2,— SUBTOTAL —,,,79900,39950");
  });

  it("is gated on the finance admin role", async () => {
    getCommissionReportMock.mockResolvedValue([]);
    const { GET } = await import("@/app/api/admin/export/commission/route");

    await GET();

    expect(requireAdminMock).toHaveBeenCalledWith("finance");
  });
});

describe("GET /api/admin/export/payments", () => {
  const req = () => new Request("https://x.test/api/admin/export/payments") as never;

  it("names the money column amount_minor_units, in its stored position", async () => {
    findManyMock.mockResolvedValue([]);
    const { GET } = await import("@/app/api/admin/export/payments/route");

    const header = (await (await GET(req())).text()).split("\r\n")[0].split(",");

    expect(header[3]).toBe("amount_minor_units");
    // The currency sits immediately beside the amount on purpose: an amount is
    // meaningless without it once a teacher can price in ~40 currencies (D-64).
    expect(header[4]).toBe("currency");
    expect(header).not.toContain("amount_centavos");
  });

  it("writes the row's own amountMinorUnits and currency, not a converted figure", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "pay_1",
        createdAt: new Date("2026-04-02T10:00:00.000Z"),
        status: "paid",
        // 20,000 CLP — a ZERO-DECIMAL currency, so this is 20,000 whole pesos
        // and not 200.00 of anything. The export must pass it through untouched.
        amountMinorUnits: 20_000,
        currency: "CLP",
        rail: "stripe",
        provider: "stripe",
        providerPaymentId: "pi_1",
        stripeCheckoutSessionId: "cs_1",
        paidAt: new Date("2026-04-02T10:01:00.000Z"),
        refundedAt: null,
        refundProviderId: null,
        package: {
          teacher: { name: "Mira", email: "mira@example.test" },
          student: { name: "Beto", email: "beto@example.test" },
          template: { name: "10 clases" },
        },
      },
    ]);
    const { GET } = await import("@/app/api/admin/export/payments/route");

    const cells = (await (await GET(req())).text()).split("\r\n")[1].split(",");

    expect(cells[3]).toBe("20000");
    expect(cells[4]).toBe("CLP");
  });

  it("is gated on the finance admin role", async () => {
    findManyMock.mockResolvedValue([]);
    const { GET } = await import("@/app/api/admin/export/payments/route");

    await GET(req());

    expect(requireAdminMock).toHaveBeenCalledWith("finance");
  });
});
