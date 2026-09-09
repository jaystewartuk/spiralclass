import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  applyE2ESkipGuards,
  blockCheckoutStub,
  clickLinkUntilNavigated,
  getPrisma,
  signInAsViaOtp,
  missingEnv,
} from "./_helpers";

// Single critical-path E2E (the concurrent-booking race). Walks:
//   sign in as the seeded teacher (`alicia-moreno`) via a planted better-auth OTP
//   → student opens the teacher's booking link → fixed-package purchase via
//   the Stripe stub → OTP sign-in as the student → student portal → reserve
//   a slot → confirmation page → portal renders the booking.
//
// Why not "teacher signup → onboarding → ...": starting from a seeded,
// onboarded teacher is faster and keeps the test focused on the student
// booking path, which is the most critical production surface.
//
// The seeded teacher (alicia-moreno) is created by `pnpm seed` and assumed
// to exist on the target DB. CI sets this up via the Migrate + Seed
// job; locally run `pnpm seed` first.
//
// Sign-in steps plant a verification row directly and POST it to the real
// `/api/auth/sign-in/email-otp` endpoint (see _helpers/better-auth.ts) — same
// code path production uses, minus the email delivery.
//
// Skips gracefully when test-DB env vars aren't set so PR builds
// without the real Supabase + Postgres stack don't fail.

applyE2ESkipGuards();

const TEACHER_EMAIL = "alicia.moreno@spiralclass.test";
const TEACHER_BOOKING_SLUG = "alicia-moreno";

const runId = randomUUID().slice(0, 8);
const studentEmail = `e2e-student-${runId}@e2e.test`;
const studentName = `Alumno ${runId}`;

test.describe.serial("happy path", () => {
  test("seeded teacher signed in → student purchase → portal → booking", async ({
    page,
    context,
  }) => {
    // Generous: the first run compiles every route it touches in `next dev`
    // (6–15s each), so one cold pass through the whole funnel adds up. The
    // warm retry is far quicker.
    test.setTimeout(240_000);
    await blockCheckoutStub(page);

    // -----------------------------------------------------------
    // 1. Sign in as the seeded teacher and confirm dashboard loads.
    // -----------------------------------------------------------
    await signInAsViaOtp(page, TEACHER_EMAIL, "/dashboard");
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /Hola/i })).toBeVisible();

    // Switch to a fresh, unauthenticated context for the student leg
    // so we don't leak the teacher's session cookies.
    await context.clearCookies();

    // -----------------------------------------------------------
    // 2. Student opens the booking link → buys a fixed package.
    // -----------------------------------------------------------
    await page.goto(`/b/${TEACHER_BOOKING_SLUG}/buy`);
    await expect(page.getByRole("heading", { name: /Alicia Moreno/i })).toBeVisible();

    // Packages-first layout renders a single shared CheckoutForm for the
    // selected package; Alicia Moreno's seed defaults the selection to the
    // cheapest tier. The payment method defaults to Stripe (the teacher is
    // seeded Stripe-ready), whose submit CTA is "Pay <price>" — the form copy
    // is hardcoded English regardless of locale. One form, so a plain locator
    // is unambiguous.
    const payButton = page.getByRole("button", { name: /^Pay\b/i });
    const checkoutForm = page.locator("form").filter({ has: payButton }).first();
    await checkoutForm.locator('input[name="studentName"]').fill(studentName);
    await checkoutForm.locator('input[name="studentEmail"]').fill(studentEmail);
    await checkoutForm.getByRole("button", { name: /^Pay\b/i }).click();

    // -----------------------------------------------------------
    // 3. Simulate payment success — the action redirected to the
    //    Stripe Checkout stub which we already aborted; flip the row
    //    directly.
    // -----------------------------------------------------------
    const prisma = getPrisma();
    let payment: { id: string; packageId: string } | null = null;
    for (let i = 0; i < 20 && !payment; i += 1) {
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
        data: { status: "paid", paidAt: new Date(), rail: "card" },
      }),
      prisma.package.update({
        where: { id: payment.packageId },
        data: { status: "active", purchasedAt: new Date() },
      }),
    ]);

    // -----------------------------------------------------------
    // 4. OTP sign-in as the student.
    // -----------------------------------------------------------
    await signInAsViaOtp(page, studentEmail, "/my-classes");
    await expect(page).toHaveURL(/\/my-classes/, { timeout: 30_000 });

    // -----------------------------------------------------------
    // 5. Portal renders the active package.
    // -----------------------------------------------------------
    await expect(page.getByRole("heading", { name: /Hola/i })).toBeVisible();
    await expect(page.getByText(/Mis paquetes/i)).toBeVisible();
    await expect(page.getByText(/\d+ clases? \/ \d+ mes/i).first()).toBeVisible();

    // -----------------------------------------------------------
    // 6. Reserve a slot → confirmation.
    // -----------------------------------------------------------
    // "Reservar una clase" is a client <Link>; retry click-then-assert so a
    // click swallowed during hydration doesn't flake the URL assertion.
    await clickLinkUntilNavigated(
      page,
      page.getByRole("link", { name: /Reservar una clase/i }),
      /\/my-classes\/book/,
    );

    // The picker now opens on a month calendar that dots the bookable days.
    // Today-in-Mexico-City may be a weekend or past Alicia Moreno's 19:00 cutoff
    // (her seed availability is Mon–Fri 09:00–13:00 + 16:00–19:00), so the
    // selected day can be empty. Land on slots via: the "next available day"
    // shortcut if it's offered, else tap a dotted day in the calendar.
    const slotLocator = page.getByRole("button").filter({ hasText: /:\d{2}/ });
    if ((await slotLocator.count()) === 0) {
      // The "next available day" shortcut and the dotted calendar days are
      // client <Link>s, so a click that lands before hydration is swallowed and
      // the day never changes — leaving the slot list empty and flaking the
      // assertion below. Both carry a `&date=` query, so retry-until-navigated
      // (idempotent nav, safe to re-click) the same way every other nav does.
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

    const firstSlot = slotLocator.first();
    await expect(firstSlot).toBeVisible({ timeout: 15_000 });
    // Tapping a slot opens a confirmation dialog; "Reservar" books it.
    await firstSlot.click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^Reservar$/i })
      .click();

    await expect(page).toHaveURL(/\/my-classes\/book\/confirmation/);
    // CardTitle from shadcn renders as a <div>, not a heading element,
    // so getByRole("heading") would miss it. Match the literal text.
    await expect(page.getByText(/¡Clase reservada!/i)).toBeVisible();

    // -----------------------------------------------------------
    // 7. Portal shows the new booking.
    // -----------------------------------------------------------
    await page.getByRole("link", { name: /Ver mis clases/i }).click();
    await expect(page).toHaveURL(/\/my-classes$/);
    await expect(page.getByText(/Próximas clases/i)).toBeVisible();
  });

  test.afterAll(async () => {
    if (missingEnv.length > 0) return;
    const prisma = getPrisma();
    // Best-effort teardown — leaves the seed teacher alone.
    await prisma.student.deleteMany({ where: { email: studentEmail } }).catch(() => undefined);
    await prisma.$disconnect();
  });
});
