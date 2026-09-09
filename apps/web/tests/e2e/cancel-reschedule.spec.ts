import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  applyE2ESkipGuards,
  bookAClass,
  clickLinkUntilNavigated,
  deleteStudentsByEmail,
  expectBothSidesNotified,
  getPrisma,
  signInAsViaOtp,
  missingEnv,
} from "./_helpers";

// Extended student-journey E2E (TEST_AUDIT_2026-06-26.md, P3): cancel and
// reschedule, beyond the single happy-path. Each test reuses the VALIDATED
// happy-path funnel (teacher sign-in → purchase → magic-link → reserve) to
// reach a confirmed booking, then exercises the cancel / reschedule flow from
// the portal.
//
// Gated on E2E_EXTENDED=1, which the e2e.yml gate sets — so these run as part of
// the promote-to-production E2E gate (and any manual workflow_dispatch),
// alongside the happy path. Validated against the live Supabase stack on
// 2026-06-26 (E2E run #94). They self-skip when E2E_EXTENDED is unset (e.g. an
// ad-hoc local `pnpm test:e2e`) so that stays green; run them locally with
// `E2E_EXTENDED=1 pnpm test:e2e`.

applyE2ESkipGuards({ extended: true });

// Wise-only teacher (seed.ts) — no Stripe rail, so /buy defaults to Wise.
const WISE_TEACHER_EMAIL = "wendy.wise@spiralclass.test";
const WISE_TEACHER_SLUG = "wendy-wise";

// The purchase → activate → reserve funnel these tests share now lives in
// _helpers/fixtures.ts (`bookAClass`) — it was three near-identical copies
// across the suite. Behaviour is unchanged; the helper is the same code.

const created: string[] = [];

test.describe.serial("student cancel + reschedule journeys", () => {
  test("student cancels a booked class → booking leaves the upcoming list", async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    const { studentEmail, bookingId } = await bookAClass(page, context);
    created.push(studentEmail);

    // §BN/§BW — reserving notifies BOTH sides (booking_confirmation to the
    // student, booking_created_teacher to the teacher). Asserted here rather
    // than inside bookAClass so the helper stays pure setup.
    await expectBothSidesNotified(bookingId, /^booking_(confirmation|created_teacher)$/);

    // Booking detail → two-step cancel (StudentCancelForm): the "Cancelar esta
    // clase" trigger opens a ConfirmDialog whose "Sí, cancelar" submits.
    await page.goto(`/my-classes/${bookingId}`);
    // In-app back affordance (not the browser's, which mobile Safari hides on
    // scroll) — every detail page needs its own way up to the parent list.
    await expect(page.getByRole("link", { name: /Mis clases/i })).toHaveAttribute(
      "href",
      "/my-classes",
    );
    await page.getByRole("button", { name: /Cancelar esta clase/i }).click();
    await page.getByRole("button", { name: /Sí, cancelar/i }).click();

    // The cancel is reflected in the DB (server re-classifies on submit).
    await expect
      .poll(
        async () => {
          const b = await getPrisma().booking.findUnique({
            where: { id: bookingId },
            select: { status: true },
          });
          return b?.status ?? "missing";
        },
        { timeout: 15_000 },
      )
      .toMatch(/canceled_by_student/);

    // §BN/§BW — cancelling notifies both sides. The exact template depends on
    // the 24h window this booking landed in (cancel_lt24h vs
    // cancel_gte24h_with_reschedule), which is why the pattern is loose — see
    // expectBothSidesNotified.
    await expectBothSidesNotified(bookingId, /^cancel_/);
  });

  test("student reschedules a booked class → new slot, original released", async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    // Book ≥24h out so the class is reschedule-eligible (a <24h class hides the
    // "Reagendar" link).
    const { studentEmail, bookingId } = await bookAClass(page, context, { aheadDays: 3 });
    created.push(studentEmail);

    const before = await getPrisma().booking.findUnique({
      where: { id: bookingId },
      select: { scheduledStart: true },
    });

    // Reschedule entry point ("Reagendar esta clase") → slot picker → pick a
    // different slot. The reschedule picker shows ONE day at a time and
    // navigates with a "Día siguiente" (Next day) button (not the booking
    // page's "next available day" shortcut), so advance day-by-day until a
    // bookable slot appears. Alicia Moreno's seed availability is Mon–Fri, so a
    // weekend landing needs a couple of clicks.
    await page.goto(`/my-classes/${bookingId}`);
    // "Reagendar" is a client <Link>; a click that lands before React finishes
    // hydrating is swallowed (the handler preventDefaults but router.push isn't
    // wired yet), and we'd then burn the full 30s URL timeout on a no-op click.
    // The shared helper retries click-then-assert until the client nav takes.
    await clickLinkUntilNavigated(
      page,
      page.getByRole("link", { name: /Reagendar/i }),
      /\/reschedule/,
    );

    const slotLocator = page.getByRole("button").filter({ hasText: /:\d{2}/ });
    const nextDay = page.getByRole("link", { name: /Día siguiente|Next day/i });
    for (let i = 0; i < 14 && (await slotLocator.count()) === 0; i += 1) {
      if ((await nextDay.getAttribute("aria-disabled")) === "true") break;
      await nextDay.click();
      await page.waitForLoadState("networkidle");
    }
    const firstSlot = slotLocator.first();
    await expect(firstSlot).toBeVisible({ timeout: 15_000 });
    // Same hydration guard as bookAClass: retry the slot tap until the confirm
    // dialog opens. The reschedule confirm dialog's CTA is "Reagendar"
    // (ConfirmSlotButton confirmLabel); allow the booking variants too.
    const confirmBtn = page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^(Reagendar|Reservar|Confirmar)$/i });
    await expect(async () => {
      await firstSlot.click();
      await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await confirmBtn.click();

    // A reschedule does NOT move the original row — it creates a NEW booking at
    // the new time and supersedes the old one (the server logs confirm:
    // reschedule_completed oldBookingId≠newBookingId). So assert a fresh
    // scheduled booking exists for this student at a DIFFERENT time, and the
    // original is no longer the active scheduled class.
    const originalStart = before?.scheduledStart?.toISOString() ?? null;
    await expect
      .poll(
        async () => {
          const fresh = await getPrisma().booking.findFirst({
            where: {
              student: { email: studentEmail },
              status: "scheduled",
              id: { not: bookingId },
            },
            select: { scheduledStart: true },
          });
          // true only once a NEW scheduled booking exists at a different time.
          return Boolean(fresh && fresh.scheduledStart?.toISOString() !== originalStart);
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const original = await getPrisma().booking.findUnique({
      where: { id: bookingId },
      select: { status: true },
    });
    expect(original?.status).not.toBe("scheduled");

    // §BN/§BW — rescheduling notifies both sides. These rows hang off the NEW
    // booking id (reschedule-handler enqueues against `created.id`), not the
    // original, so resolve it first — querying the old id would find only the
    // original booking_confirmation pair and quietly pass for the wrong reason.
    const rescheduled = await getPrisma().booking.findFirst({
      where: { rescheduleOfBookingId: bookingId },
      select: { id: true },
    });
    expect(rescheduled, "reschedule should have created a successor booking").toBeTruthy();
    await expectBothSidesNotified(rescheduled!.id, /^reschedule_confirm/);
  });

  test("student pays via Wise → teacher confirms → package activates", async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    const runId = randomUUID().slice(0, 8);
    const studentEmail = `e2e-wise-${runId}@e2e.test`;
    const studentName = `Alumno ${runId}`;
    created.push(studentEmail);
    const prisma = getPrisma();

    // 1. Anonymous student opens the Wise-only teacher's booking page. With no
    //    Stripe rail there's no method toggle — the form defaults to the
    //    manual transfer and its CTA is the rail-neutral "Continue".
    await page.goto(`/b/${WISE_TEACHER_SLUG}/buy`);
    const continueBtn = page.getByRole("button", {
      name: /^(Continue|Continuar)$/i,
    });
    const checkoutForm = page.locator("form").filter({ has: continueBtn }).first();
    await checkoutForm.locator('input[name="studentName"]').fill(studentName);
    await checkoutForm.locator('input[name="studentEmail"]').fill(studentEmail);
    await continueBtn.click();

    // 2. Lands on the transfer instructions page (D-113 generalized the URL
    //    off /buy/wise/ to /buy/transfer/), reference + "Open Wise", then the
    //    student claims they've paid.
    await expect(page).toHaveURL(/\/buy\/transfer\//);
    await expect(page.getByRole("heading", { name: /Pay with Wise|Paga con Wise/i })).toBeVisible();
    await page.getByRole("button", { name: /I've sent the payment|Ya envié el pago/i }).click();

    // 3. A pending Wise payment now exists for this student.
    let payment: { id: string; packageId: string } | null = null;
    for (let i = 0; i < 20 && !payment; i += 1) {
      payment = await prisma.payment.findFirst({
        where: { provider: "manual_transfer", package: { student: { email: studentEmail } } },
        select: { id: true, packageId: true },
        orderBy: { createdAt: "desc" },
      });
      if (!payment) await page.waitForTimeout(250);
    }
    if (!payment) throw new Error("no pending Wise payment row created");

    // 4. Sign in as the Wise teacher and confirm receipt from the payment page.
    await context.clearCookies();
    await signInAsViaOtp(page, WISE_TEACHER_EMAIL, `/payments/${payment.id}`);
    await expect(page).toHaveURL(new RegExp(`/payments/${payment.id}`), { timeout: 30_000 });
    await page.getByRole("button", { name: /Mark as received|Marcar como recibido/i }).click();

    // 5. Confirmation flips the payment to paid and activates the package.
    await expect
      .poll(
        async () => {
          const p = await getPrisma().payment.findUnique({
            where: { id: payment!.id },
            select: { status: true },
          });
          return p?.status ?? "missing";
        },
        { timeout: 15_000 },
      )
      .toBe("paid");

    const pkg = await prisma.package.findUnique({
      where: { id: payment.packageId },
      select: { status: true },
    });
    expect(pkg?.status).toBe("active");
  });

  test.afterAll(async () => {
    if (missingEnv.length > 0 || process.env.E2E_EXTENDED !== "1") return;
    await deleteStudentsByEmail(created).catch(() => undefined);
    await getPrisma().$disconnect();
  });
});
