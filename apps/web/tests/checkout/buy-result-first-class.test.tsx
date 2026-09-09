import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

// The page's JSX compiles against the classic runtime under vitest — same
// shim as tests/settings/*-inline-validation.test.tsx.
(globalThis as Record<string, unknown>).React = React;

// /b/[slug]/buy/result — pins HOW the page decides the picked first class
// (D-111 pay-at-reservation intent) actually landed.
//
// The booking core spends the soonest-to-expire credit across EVERY active
// package the student holds with the teacher (lib/booking/credit-ledger), so a
// top-up bought while an older package is still live has its first class booked
// on the OLDER package. The page used to read `package.bookings` on the package
// just paid for, which is empty in that case — and told a repeat buyer her
// class wasn't scheduled ("next step: book") when it was. The lookup must be by
// student + teacher + start, the same tuple lib/booking/auto-book-intended.ts
// dedupes on.

const paymentFindFirst = vi.fn();
const bookingFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findFirst: (...a: unknown[]) => paymentFindFirst(...a) },
    booking: { findFirst: (...a: unknown[]) => bookingFindFirst(...a) },
  },
}));

// The funnel's locale comes from the teacher via a DB lookup the prisma mock
// above deliberately doesn't carry. It IS load-bearing for the slot line, so
// it's a settable seam rather than a constant.
const funnel = vi.hoisted(() => ({ locale: "en" }));
vi.mock("@/lib/booking/funnel-locale", () => ({
  funnelLocaleForSlug: async () => funnel.locale,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentStudent: vi.fn(async () => null),
}));
vi.mock("@/lib/i18n", () => ({
  getPublicFunnelT: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/app/b/[slug]/buy/result/resend-sign-in-link", () => ({
  ResendSignInLink: () => null,
}));

const INTENDED = new Date("2026-09-01T17:00:00.000Z");

function paidPayment(over: Record<string, unknown> = {}) {
  return {
    id: "pay_1",
    status: "paid",
    provider: "stripe",
    amountMinorUnits: 50_000,
    currency: "MXN",
    externalReference: "ref_1",
    paymentReference: null,
    package: {
      status: "active",
      teacherId: "t1",
      studentId: "s1",
      intendedStartUtc: INTENDED,
      classesTotal: 8,
      classDurationMin: 50,
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      template: { name: "8 clases" },
      student: { id: "s1", email: "mira@example.com", name: "Mira" },
      teacher: { name: "Profe", timezone: "America/Mexico_City" },
    },
    ...over,
  };
}

async function renderPage() {
  const { default: Page } = await import("@/app/b/[slug]/buy/result/page");
  const el = await Page({
    params: Promise.resolve({ slug: "profe" }),
    searchParams: Promise.resolve({ ref: "ref_1" }),
  });
  return renderToStaticMarkup(el);
}

describe("/b/[slug]/buy/result — first-class landed lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    funnel.locale = "en";
    paymentFindFirst.mockResolvedValue(paidPayment());
  });

  it("looks the booking up by student + teacher + start, not through the paid package", async () => {
    bookingFindFirst.mockResolvedValue({ id: "bk_on_older_pkg" });

    const html = await renderPage();

    expect(bookingFindFirst).toHaveBeenCalledTimes(1);
    const where = bookingFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      teacherId: "t1",
      studentId: "s1",
      scheduledStart: INTENDED,
      status: { notIn: ["canceled_by_student", "canceled_by_teacher"] },
    });
    expect(where.packageId).toBeUndefined();
    // The payment query no longer needs the package's own bookings.
    const include = paymentFindFirst.mock.calls[0][0].include;
    expect(include.package.select.bookings).toBeUndefined();

    // A top-up whose first class landed on the older package reads as scheduled:
    // the card states the slot outright rather than promising to book it.
    expect(html).toContain("web.buyResult.firstClassTitle");
    expect(html).not.toContain("web.buyResult.firstClassPending");
    expect(html).toContain("web.buyResult.nextStepAfterFirstClass");
    expect(html).not.toContain("web.buyResult.nextStepBook");
  });

  it("does not claim a class is scheduled when nothing landed at that start", async () => {
    bookingFindFirst.mockResolvedValue(null);

    const html = await renderPage();

    expect(html).toContain("web.buyResult.firstClassPending");
    expect(html).toContain("web.buyResult.nextStepBook");
  });

  it("skips the booking lookup entirely for a purchase with no picked slot", async () => {
    paymentFindFirst.mockResolvedValue(
      paidPayment({
        package: {
          ...paidPayment().package,
          intendedStartUtc: null,
        },
      }),
    );

    const html = await renderPage();

    expect(bookingFindFirst).not.toHaveBeenCalled();
    expect(html).toContain("web.buyResult.nextStepBook");
  });
});

// The rest of the page's judgement calls, which are all things it got wrong
// before it was rebuilt as a receipt.
describe("/b/[slug]/buy/result — presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    funnel.locale = "en";
    paymentFindFirst.mockResolvedValue(paidPayment());
    bookingFindFirst.mockResolvedValue(null);
  });

  it("renders the picked slot in the FUNNEL's locale, not a hardcoded en-US", async () => {
    funnel.locale = "fr";
    bookingFindFirst.mockResolvedValue({ id: "bk_1" });

    const html = await renderPage();

    // 2026-09-01 17:00Z is midday in America/Mexico_City — the zone the picker
    // quoted it in. A French funnel that picked the slot in French must be told
    // about it in French.
    expect(html).toContain("septembre");
    expect(html).not.toContain("September");
  });

  it("summarises what was bought — package, classes, teacher, expiry, total", async () => {
    const html = await renderPage();

    expect(html).toContain("web.buyResult.summaryTitle");
    expect(html).toContain("8 clases");
    expect(html).toContain("web.wiseInstructions.classesOf");
    expect(html).toContain("Profe");
    expect(html).toContain("web.buyResult.summaryUseBy");
    // Paid, so the total is labelled as settled rather than merely owed.
    expect(html).toContain("web.buyResult.summaryPaid");
    expect(html).not.toContain("web.buyResult.summaryAmount");
  });

  it("labels the total as an amount, not as paid, when the payment failed", async () => {
    paymentFindFirst.mockResolvedValue(paidPayment({ status: "failed" }));

    const html = await renderPage();

    expect(html).toContain("web.buyResult.summaryAmount");
    expect(html).not.toContain("web.buyResult.summaryPaid");
    // …and no expiry deadline for classes this payment never bought.
    expect(html).not.toContain("web.buyResult.summaryUseBy");
    // A payment that failed booked nothing, so the "we'll book it once the
    // payment confirms" promise is withdrawn rather than left standing.
    expect(html).toContain("web.buyResult.firstClassNotBooked");
    expect(html).not.toContain("web.buyResult.firstClassPending");
  });

  it("offers the portal, not 'book your first class', once the first class landed", async () => {
    const { getCurrentStudent } = await import("@/lib/auth");
    vi.mocked(getCurrentStudent).mockResolvedValue({ id: "s1" } as never);
    bookingFindFirst.mockResolvedValue({ id: "bk_1" });

    const html = await renderPage();

    expect(html).toContain("book.confirm.viewMine");
    expect(html).toContain("book.confirm.bookAnother");
    expect(html).not.toContain("web.buyResult.bookFirstClass");
  });

  it("offers no second booking button when the single class bought is already booked", async () => {
    const { getCurrentStudent } = await import("@/lib/auth");
    vi.mocked(getCurrentStudent).mockResolvedValue({ id: "s1" } as never);
    paymentFindFirst.mockResolvedValue(
      paidPayment({ package: { ...paidPayment().package, classesTotal: 1 } }),
    );
    bookingFindFirst.mockResolvedValue({ id: "bk_1" });

    const html = await renderPage();

    expect(html).toContain("book.confirm.viewMine");
    expect(html).not.toContain("book.confirm.bookAnother");
    expect(html).not.toContain("web.buyResult.bookFirstClass");
  });
});
