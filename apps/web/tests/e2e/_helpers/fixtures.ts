import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

import { getPrisma } from "./prisma";
import { signInAsViaOtp } from "./better-auth";
import { blockCheckoutStub, clickLinkUntilNavigated } from "./web";
import { nextWeekdayISO } from "./dates";

// Shared journey fixtures: drive the validated purchase funnel (and optionally
// on to a confirmed booking) so a spec that only wants "a student with an
// active package" doesn't re-copy 100 lines to get one.
//
// Extracted verbatim from cancel-reschedule.spec.ts's private `bookAClass`,
// which itself carried a "copied verbatim from happy-path.spec.ts" note — so
// the selectors here inherit that spec's live-stack validation (E2E run #94,
// 2026-06-26) rather than being newly invented.
//
// DELIBERATELY NOT used by happy-path.spec.ts. That spec is the one
// non-extended journey — the promote gate's critical path — and its inline
// copy of this funnel interleaves assertions (the dashboard "Hola" heading,
// the "Mis paquetes" / "N clases / N mes" portal copy) that ARE the test
// rather than setup. Folding it into a shared setup helper would silently
// delete those assertions. The remaining duplication is that spec's inline
// version vs this one; every other spec should use this.
//
// The API-transport equivalent (`buildLinkedStudentWithActivePackage` in
// mobile-student-booking.api.spec.ts) is still private to that file — it
// drives /api/mobile/* rather than the browser, so it shares the shape but
// none of the code. Extract it here too if a second API spec needs it.

// The E2E-critical seeded teacher (scripts/seed.ts). Stripe-ready stub,
// availability Mon–Fri. Her email/slug/templates are pinned by the seed
// file's own header — don't swap these for another fixture.
export const TEACHER_EMAIL = "alicia.moreno@spiralclass.test";
export const TEACHER_BOOKING_SLUG = "alicia-moreno";

// Playwright's BrowserContext, narrowed to the one method these helpers use.
type CookieClearable = { clearCookies: () => Promise<void> };

export type PurchasedPackage = {
  studentEmail: string;
  studentName: string;
  paymentId: string;
  packageId: string;
};

export type PurchaseOptions = {
  /** Teacher to buy from. Defaults to the seeded alicia-moreno. */
  teacherEmail?: string;
  teacherSlug?: string;
  /**
   * Extra columns to write onto the payment row when flipping it to `paid`.
   * The Checkout stub is aborted rather than followed, so Stripe never writes
   * back the ids a real charge would leave behind — a spec that exercises a
   * downstream Stripe call (refund needs `providerPaymentId`) has to plant
   * them here. There is no longer a transfer id to plant: direct charges
   * settle on the teacher's own account, so the platform makes no transfer
   * (D-143).
   */
  paymentOverrides?: Record<string, unknown>;
};

// Buys a fixed package from the teacher's public booking page via the Stripe
// stub and flips it to paid/active, returning the new student's identifiers.
//
// Signs in as the teacher first and then clears cookies — that step is load-
// bearing beyond "proving the stack is up": it's the cheapest assertion that
// the seed actually ran, so a missing/renamed fixture fails here with a
// sign-in error instead of surfacing 60 lines later as an empty slot grid.
export async function purchaseAndActivatePackage(
  page: Page,
  context: CookieClearable,
  opts: PurchaseOptions = {},
): Promise<PurchasedPackage> {
  const teacherEmail = opts.teacherEmail ?? TEACHER_EMAIL;
  const teacherSlug = opts.teacherSlug ?? TEACHER_BOOKING_SLUG;

  const runId = randomUUID().slice(0, 8);
  const studentEmail = `e2e-student-${runId}@e2e.test`;
  const studentName = `Alumno ${runId}`;
  const prisma = getPrisma();

  await blockCheckoutStub(page);

  await signInAsViaOtp(page, teacherEmail, "/dashboard");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  await context.clearCookies();

  await page.goto(`/b/${teacherSlug}/buy`);
  const payButton = page.getByRole("button", { name: /^Pay\b/i });
  const checkoutForm = page.locator("form").filter({ has: payButton }).first();
  await checkoutForm.locator('input[name="studentName"]').fill(studentName);
  await checkoutForm.locator('input[name="studentEmail"]').fill(studentEmail);
  await checkoutForm.getByRole("button", { name: /^Pay\b/i }).click();

  // The pending payment row is written by the checkout action asynchronously,
  // so poll for it — up to 15s, since a loaded CI runner can take several
  // seconds to land the row (a tighter 5s budget flaked the reschedule
  // journey's setup).
  let payment: { id: string; packageId: string } | null = null;
  for (let i = 0; i < 60 && !payment; i += 1) {
    payment = await prisma.payment.findFirst({
      where: { package: { student: { email: studentEmail } } },
      select: { id: true, packageId: true },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) await page.waitForTimeout(250);
  }
  if (!payment) throw new Error("no payment row created for student");

  await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "paid",
        paidAt: new Date(),
        rail: "card",
        ...(opts.paymentOverrides ?? {}),
      },
    }),
    prisma.package.update({
      where: { id: payment.packageId },
      data: { status: "active", purchasedAt: new Date() },
    }),
  ]);

  return { studentEmail, studentName, paymentId: payment.id, packageId: payment.packageId };
}

export type BookOptions = PurchaseOptions & {
  /**
   * Force the booking onto a specific future weekday (via the reservar page's
   * ?date= param). Use for a ≥24h-eligible class — reschedule is 24h-gated
   * and cancel inside 24h forfeits the class, so a spec that needs the free
   * window must not take "whatever slot happens to be first".
   */
  aheadDays?: number;
};

// Drives the funnel all the way to a confirmed booking.
export async function bookAClass(
  page: Page,
  context: CookieClearable,
  opts: BookOptions = {},
): Promise<PurchasedPackage & { bookingId: string }> {
  const purchased = await purchaseAndActivatePackage(page, context, opts);
  const prisma = getPrisma();

  await signInAsViaOtp(page, purchased.studentEmail, "/my-classes");
  await expect(page).toHaveURL(/\/my-classes/, { timeout: 30_000 });

  const slotLocator = page.getByRole("button").filter({ hasText: /:\d{2}/ });
  if (opts.aheadDays && opts.aheadDays > 0) {
    await page.goto(
      `/my-classes/book?packageId=${purchased.packageId}&date=${nextWeekdayISO(opts.aheadDays)}`,
    );
    await expect(page).toHaveURL(/\/my-classes\/book/);
    await page.waitForLoadState("networkidle");
  } else {
    // "Reservar una clase" is a client <Link>; a click during hydration is
    // swallowed, so retry click-then-assert until the SPA nav lands (else the
    // URL assertion burns its full timeout on a no-op click and flakes).
    await clickLinkUntilNavigated(
      page,
      page.getByRole("link", { name: /Reservar una clase/i }),
      /\/my-classes\/book/,
    );
    if ((await slotLocator.count()) === 0) {
      // The "next available day" shortcut and the dotted calendar days are
      // client <Link>s — a pre-hydration click is swallowed and the day never
      // changes. Both carry a `&date=` query, so retry-until-navigated rather
      // than a single click that could no-op and leave the slot list empty.
      const nextAvailable = page.getByRole("link", { name: /próximo día disponible/i });
      // Selected by test id, not by accessible name: that name is the
      // localized date and is presentation, which is why keying on it broke
      // this journey when #1006 improved it.
      const target =
        (await nextAvailable.count()) > 0
          ? nextAvailable.first()
          : page.getByTestId("calendar-day-available").first();
      await clickLinkUntilNavigated(page, target, /[?&]date=/);
    }
  }

  const firstSlot = slotLocator.first();
  await expect(firstSlot).toBeVisible({ timeout: 15_000 });
  // Tapping a slot opens a confirm dialog — it does NOT navigate. A tap that
  // lands before the slot grid has hydrated is swallowed, so the dialog never
  // opens and the following dialog-button click fails. Retry tap-until-dialog
  // (same idea as clickLinkUntilNavigated, for a dialog instead of a nav); the
  // dialog's "Reservar" is what navigates to the confirmation page.
  const reservarBtn = page.getByRole("alertdialog").getByRole("button", { name: /^Reservar$/i });
  await expect(async () => {
    await firstSlot.click();
    await expect(reservarBtn).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await reservarBtn.click();
  await expect(page).toHaveURL(/\/my-classes\/book\/confirmation/);

  const booking = await prisma.booking.findFirst({
    where: { student: { email: purchased.studentEmail }, status: "scheduled" },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!booking) throw new Error("no scheduled booking row after reservation");
  return { ...purchased, bookingId: booking.id };
}

// The queued notifications a booking has accumulated, newest last.
//
// UAT §BN/§BW assert that book / cancel / reschedule NOTIFY both sides. The
// producers (lib/notifications/enqueue.ts) write these rows inside the same
// transaction as the booking mutation itself, so they are readable the moment
// the mutation lands — it's only DELIVERY that goes through Inngest, which
// isn't running in the hermetic gate. Asserting the queued row is therefore
// both the strongest claim this environment can make and the right one: a
// dropped `enqueue*` call is the regression that silently stops teachers being
// told anything, and it would leave every other assertion in these specs green.
//
// `status` is deliberately NOT asserted anywhere: with no dispatcher running
// these stay 'queued' forever, so pinning it would encode "Inngest is absent"
// as an expectation and start failing the day the gate gains a worker.
export async function notificationsForBooking(
  bookingId: string,
): Promise<Array<{ templateName: string; recipientType: string }>> {
  const prisma = getPrisma();
  return prisma.notification.findMany({
    where: { bookingId },
    select: { templateName: true, recipientType: true },
    orderBy: { createdAt: "asc" },
  });
}

// Asserts a booking notified both sides, without over-pinning WHICH template.
//
// `templatePattern` stays loose (e.g. /^cancel_/) on purpose: the exact
// template depends on the 24h classification, and a booking made against
// "whatever slot is free next" can land either side of that line depending on
// the hour the gate runs. Which template a given window maps to is already
// pinned by lib/cancellation/classify.ts's unit tests; duplicating that here
// would just make the suite time-of-day dependent.
export async function expectBothSidesNotified(
  bookingId: string,
  templatePattern: RegExp,
): Promise<void> {
  const rows = await notificationsForBooking(bookingId);
  const matching = rows.filter((r) => templatePattern.test(r.templateName));
  const recipients = matching.map((r) => r.recipientType);
  expect(
    recipients,
    `expected a ${templatePattern} notification for both student and teacher; got ${JSON.stringify(rows)}`,
  ).toEqual(expect.arrayContaining(["student", "teacher"]));
}

// Deletes the students a spec created, by email. Safe to call with emails that
// were never created (a spec that failed before its first purchase).
export async function deleteStudentsByEmail(emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  const prisma = getPrisma();
  await prisma.student.deleteMany({ where: { email: { in: emails } } });
}
