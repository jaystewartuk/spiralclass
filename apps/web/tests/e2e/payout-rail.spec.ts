import { test, expect } from "@playwright/test";

import { applyE2ESkipGuards, getPrisma, missingEnv, signInAsViaOtp } from "./_helpers";

// UAT §A+ — a teacher connects a payout rail.
//
// Covers the WISE half only. Stripe Connect onboarding (§A+.stripe) hands off
// to Stripe's own hosted flow on a stripe.com domain — there is nothing on our
// side to drive past the redirect, so automating it would assert only that we
// mint an AccountLink, which lib/stripe unit tests already cover. The Wise rail
// is entirely ours end to end, so it's the half worth an E2E.
//
// The assertion that matters is NOT "the form saved". It's that connecting the
// rail changes what a STUDENT sees: the public booking page flips from
// unlisted (Next's not-found UI — no payout rail fails isPubliclyListed()'s
// hasPayoutMethod signal, D-104; the response status is still 200 here, this
// build doesn't propagate notFound() to a real 404 status, so the check is
// content-based) to an actual Wise checkout CTA. Teacher-side persistence and
// student-side availability are wired through separate code
// (the payout instrument → the /b/<slug>/buy rail resolver), and a
// regression in that link is invisible to any teacher-only assertion —
// the teacher's settings page would keep saying "connected" while every
// student silently can't even reach her page.
//
// Fixture: `nora-norail`, seeded with NO rail and owned exclusively by this
// spec (see scripts/seed.ts). This journey MUTATES her rail, so it must not
// run against a hero another spec asserts on — subscription-and-rails.spec.ts
// pins both the no-rail (unlisted) state and the Wise-only state on other
// teachers.
//
// Gated on E2E_EXTENDED=1 like every journey beyond the happy path.

applyE2ESkipGuards({ extended: true });

const NO_RAIL_TEACHER_EMAIL = "nora.norail@spiralclass.test";
const NO_RAIL_TEACHER_SLUG = "nora-norail";

const WISE_HANDLE = "noranorail";
const WISE_ACCOUNT_HOLDER = "Nora Sinriel";

test.describe.serial("connect a payout rail (§A+)", () => {
  test("teacher with no rail connects Wise → students can pay her", async ({ page }) => {
    test.setTimeout(240_000);
    const prisma = getPrisma();

    // ---- Precondition: no rail, so her public page isn't listed at all ----
    // Asserted rather than assumed: if a previous run crashed before its
    // cleanup, this fails immediately and points at the dirty fixture instead
    // of the "connect" step mysteriously proving nothing.
    await page.goto(`/b/${NO_RAIL_TEACHER_SLUG}/buy`);
    await expect(
      page.getByRole("heading", { name: /Página no encontrada|Page not found/i }),
    ).toBeVisible({ timeout: 30_000 });

    // ---- Teacher connects the Wise rail ----
    await signInAsViaOtp(page, NO_RAIL_TEACHER_EMAIL, "/settings/payments");
    await expect(page).toHaveURL(/\/settings\/payments/, { timeout: 30_000 });

    // One form, one submit: the toggle and the handle are saved together (the
    // validator refuses to enable without a handle), so fill both then save.
    await page.getByLabel(/Aceptar pagos con Wise|Accept payments via Wise/i).check();
    await page.getByLabel(/Tu Wisetag|Your Wisetag/i).fill(WISE_HANDLE);
    await page.getByLabel(/Nombre de la cuenta|Account holder/i).fill(WISE_ACCOUNT_HOLDER);
    await page.getByRole("button", { name: /Guardar Wise|Save Wise/i }).click();

    // The action redirects back with ?wise=1 on success.
    await expect(page).toHaveURL(/\/settings\/payments\?wise=1/, { timeout: 30_000 });

    await expect
      .poll(
        async () => {
          // D-113: the rail is a TeacherPayoutInstrument row, not two
          // columns on the teacher.
          const i = await prisma.teacherPayoutInstrument.findFirst({
            where: { teacher: { email: NO_RAIL_TEACHER_EMAIL }, kind: "wise" },
            select: { enabled: true, wiseHandle: true },
          });
          return `${i?.enabled}:${i?.wiseHandle}`;
        },
        { timeout: 15_000 },
      )
      .toBe(`true:${WISE_HANDLE}`);

    // ---- The rail is now visible to STUDENTS (the point of the spec) ----
    await page.context().clearCookies();
    await page.goto(`/b/${NO_RAIL_TEACHER_SLUG}/buy`);
    // ...the page is publicly listed now, not the not-found UI from before.
    await expect(
      page.getByRole("heading", { name: /Página no encontrada|Page not found/i }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Continue|Continuar)$/i })).toBeVisible({
      timeout: 30_000,
    });
  });

  // Restores the fixture to its seeded no-rail state. Runs even when the test
  // above fails, so a failed assertion doesn't also poison the next run's
  // precondition check. A hard crash can still skip this — that's why the
  // fixture is dedicated (see the header) and re-seeding is the real backstop.
  test.afterAll(async () => {
    if (missingEnv.length > 0 || process.env.E2E_EXTENDED !== "1") return;
    const prisma = getPrisma();
    // The payout rail is a RELATION since D-113, so resetting it means
    // deleting the rows this run created — a scalar update can't clear it, and
    // the `wise*` teacher columns it used to null out no longer exist.
    await prisma.teacherPayoutInstrument
      .deleteMany({ where: { teacher: { email: NO_RAIL_TEACHER_EMAIL } } })
      .catch(() => undefined);
    await prisma.teacher
      .updateMany({
        where: { email: NO_RAIL_TEACHER_EMAIL },
        data: { pricingCurrency: "MXN" },
      })
      .catch(() => undefined);
    await prisma.$disconnect();
  });
});
