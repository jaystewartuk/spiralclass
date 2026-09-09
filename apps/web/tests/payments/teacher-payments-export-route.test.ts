import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// GET /api/teacher/payments/export — a teacher's own payments as a
// spreadsheet, for her books. Pins the things that would cost real money or
// real privacy if they drifted: the auth gate, the tenancy filter, that the
// view and search on screen are the rows in the file, that amounts leave as
// integer minor units beside their currency rather than as formatted text, and
// that a name which looks like a spreadsheet formula is neutralised.

const requireOnboardedTeacherMock = vi.fn(async () => ({
  id: "teacher-1",
  timezone: "America/Mexico_City",
}));
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: () => requireOnboardedTeacherMock(),
}));

type Row = Record<string, unknown>;
const paymentFindManyMock = vi.fn(async (..._: unknown[]): Promise<Row[]> => []);
vi.mock("@/lib/prisma", () => ({
  prisma: { payment: { findMany: (...a: unknown[]) => paymentFindManyMock(...a) } },
}));

const { GET } = await import("@/app/api/teacher/payments/export/route");

function get(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

function payment(over: Row = {}): Row {
  return {
    id: "pay-1",
    createdAt: new Date("2026-09-02T10:00:00.000Z"),
    status: "paid",
    provider: "stripe",
    rail: "card",
    amountMinorUnits: 150_000,
    currency: "MXN",
    paymentReference: null,
    paidAt: new Date("2026-09-02T10:00:05.000Z"),
    refundedAt: null,
    confirmedAt: null,
    package: {
      classesTotal: 8,
      student: { name: "Mira Sofía", email: "mira@example.com" },
      template: { name: "8-class package" },
    },
    ...over,
  };
}

/** The `where` Prisma was actually handed on the last call. */
function lastWhere(): { AND: Record<string, unknown>[] } {
  const call = paymentFindManyMock.mock.calls.at(-1)?.[0] as { where: { AND: Row[] } };
  return call.where as { AND: Record<string, unknown>[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  paymentFindManyMock.mockResolvedValue([]);
});

describe("GET /api/teacher/payments/export", () => {
  it("is gated on an onboarded teacher, before anything is read", async () => {
    await GET(get("https://test.local/api/teacher/payments/export"));
    expect(requireOnboardedTeacherMock).toHaveBeenCalledTimes(1);
  });

  it("scopes every row to the caller's own packages", async () => {
    // The one thing that must never regress here: this endpoint emits names,
    // emails and amounts, so a missing tenancy clause is a cross-teacher leak.
    await GET(get("https://test.local/api/teacher/payments/export"));
    expect(lastWhere().AND).toContainEqual({ package: { teacherId: "teacher-1" } });
  });

  it("keeps tenancy as its own AND clause when a search narrows the file", async () => {
    // `paymentReference` matches with no teacher constraint of its own, so the
    // two clauses have to sit side by side rather than the search replacing
    // the scope.
    await GET(get("https://test.local/api/teacher/payments/export?q=AGP-1A2B"));
    const { AND } = lastWhere();
    expect(AND).toContainEqual({ package: { teacherId: "teacher-1" } });
    expect(AND).toContainEqual({
      OR: [
        { package: { student: { name: { contains: "AGP-1A2B", mode: "insensitive" } } } },
        { package: { student: { email: { contains: "AGP-1A2B", mode: "insensitive" } } } },
        { paymentReference: { contains: "AGP-1A2B", mode: "insensitive" } },
      ],
    });
  });

  it("filters to the view the page was showing", async () => {
    await GET(get("https://test.local/api/teacher/payments/export?show=refunded"));
    expect(lastWhere().AND).toContainEqual({ status: { in: ["refunded"] } });
  });

  it("filters by nothing at all on the unfiltered ledger", async () => {
    // `all` includes `failed`, which has no view of its own — the export has
    // to carry it for the same reason the page does.
    await GET(get("https://test.local/api/teacher/payments/export"));
    expect(lastWhere().AND).toEqual([{ package: { teacherId: "teacher-1" } }]);
  });

  it("ignores an unrecognised view rather than erroring on a hand-edited URL", async () => {
    await GET(get("https://test.local/api/teacher/payments/export?show=../../etc/passwd"));
    expect(lastWhere().AND).toEqual([{ package: { teacherId: "teacher-1" } }]);
  });

  it("serves a downloadable CSV, newest first, under a row cap", async () => {
    const res = await GET(get("https://test.local/api/teacher/payments/export"));
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="payments-/);
    expect(paymentFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" }, take: 10_000 }),
    );
  });

  it("writes amounts as integer minor units beside their currency", async () => {
    // "$1,500.00 MXN" is text a spreadsheet cannot sum. The integer is the
    // value every accounting tool wants and the code column disambiguates it.
    paymentFindManyMock.mockResolvedValue([payment()]);
    const [header, row] = (
      await (await GET(get("https://test.local/api/teacher/payments/export"))).text()
    ).split("\r\n");

    const columns = header.split(",");
    const cells = row.split(",");
    const cell = (name: string) => cells[columns.indexOf(name)];

    expect(cell("amount_minor_units")).toBe("150000");
    expect(cell("currency")).toBe("MXN");
    expect(cell("student_name")).toBe("Mira Sofía");
    expect(cell("package")).toBe("8-class package");
    expect(cell("status")).toBe("paid");
    expect(cell("created_at")).toBe("2026-09-02T10:00:00.000Z");
  });

  it("leaves a missing package name and the unset timestamps empty, not 'null'", async () => {
    paymentFindManyMock.mockResolvedValue([
      payment({
        package: {
          classesTotal: 1,
          student: { name: "Beto", email: "beto@example.com" },
          template: null,
        },
        paidAt: null,
        confirmedAt: null,
        refundedAt: null,
        paymentReference: null,
      }),
    ]);
    const body = await (await GET(get("https://test.local/api/teacher/payments/export"))).text();
    expect(body.split("\r\n")[1]).toMatch(/,,,$/);
    expect(body).not.toContain("null");
  });

  it("neutralises a student name that a spreadsheet would run as a formula", async () => {
    // Names are typed freely at public checkout, and this file opens on the
    // teacher's own machine.
    paymentFindManyMock.mockResolvedValue([
      payment({
        package: {
          classesTotal: 1,
          student: { name: '=HYPERLINK("http://evil","click")', email: "x@example.com" },
          template: { name: "Single class" },
        },
      }),
    ]);
    const body = await (await GET(get("https://test.local/api/teacher/payments/export"))).text();
    expect(body).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(body).not.toContain(",=HYPERLINK");
  });
});
