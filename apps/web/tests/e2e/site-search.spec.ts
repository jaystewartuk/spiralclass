import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { applyE2ESkipGuards, getPrisma, signInAsViaOtp } from "./_helpers";

// The site-wide search, walked the way it was asked for: a teacher who could
// not find her students, her day plan or her packages types what she calls
// them and lands there. Then a record: her student, by a name typed without
// its accent. The unit tests own the ranking and the coverage of every page;
// this owns the wiring between the header, the dialog, the index route and
// the router.
//
// Owns its teacher (created here, deleted in afterAll). The suite runs with
// the browser locale pinned to es (playwright.config.ts), so the queries are
// what a Spanish-reading teacher would type.
applyE2ESkipGuards({ extended: true });

const RUN = randomUUID().slice(0, 8);
const TEACHER_ID = randomUUID();
const TEACHER_EMAIL = `site-search-${RUN}@spiralclass.test`;
const STUDENT_EMAIL = `ines-${RUN}@spiralclass.test`;
const STUDENT_NAME = `Inés Navarro ${RUN}`;

let studentId = "";

test.beforeAll(async () => {
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, $2, $3, true, now(), now())`,
    TEACHER_ID,
    "Site Search Teacher",
    TEACHER_EMAIL,
  );
  await prisma.teacher.create({
    data: {
      id: TEACHER_ID,
      email: TEACHER_EMAIL,
      name: "Site Search Teacher",
      timezone: "America/Mexico_City",
      locale: "es",
      country: "MX",
      bookingSlug: `site-search-${RUN}`,
      onboardingCompleteAt: new Date(),
    },
  });
  const student = await prisma.student.create({
    data: { email: STUDENT_EMAIL, name: STUDENT_NAME },
    select: { id: true },
  });
  studentId = student.id;
  await prisma.teacherStudent.create({ data: { teacherId: TEACHER_ID, studentId } });
});

test.afterAll(async () => {
  const prisma = getPrisma();
  await prisma.teacherStudent.deleteMany({ where: { teacherId: TEACHER_ID } }).catch(() => {});
  await prisma.student.deleteMany({ where: { email: STUDENT_EMAIL } }).catch(() => {});
  await prisma.teacher.delete({ where: { id: TEACHER_ID } }).catch(() => {});
});

async function searchAndGo(page: Page, query: string, open: "click" | "shortcut") {
  if (open === "click") {
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
  } else {
    await page.keyboard.press("ControlOrMeta+k");
  }
  const box = page.getByRole("combobox");
  await expect(box).toBeFocused();
  await box.fill(query);
  await box.press("Enter");
}

test("a teacher finds pages by her own words, and a student by name", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAsViaOtp(page, TEACHER_EMAIL, "/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  // Her word, not the menu's: "paquete" lands on the packages page, which the
  // nav files under Settings → Templates.
  await searchAndGo(page, "paquete", "click");
  await expect(page).toHaveURL(/\/settings\/templates$/);

  // A page no menu links to at all.
  await searchAndGo(page, "planear mi día", "shortcut");
  await expect(page).toHaveURL(/\/dashboard\/classes\/plan/);

  // Her records: the student, found without typing the accents. The index
  // loads when the dialog opens, so wait for the row rather than racing Enter.
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  const box = page.getByRole("combobox");
  await box.fill(`ines navarro ${RUN}`);
  await expect(page.getByRole("option", { name: new RegExp(STUDENT_NAME) }).first()).toBeVisible();
  await box.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/dashboard/students/${studentId}$`));

  // Escape closes it without going anywhere.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("combobox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/dashboard/students/${studentId}$`));
});
