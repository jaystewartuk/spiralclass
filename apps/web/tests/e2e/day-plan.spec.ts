import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { applyE2ESkipGuards, getPrisma, signInAsViaOtp } from "./_helpers";

// The day plan (/dashboard/classes/plan) — a teacher's planning notebook: one
// page per day, a section per class, her private cues under each. Walks: the
// day lists both classes and flags the one that ends the package → write a cue
// and see it land on this page → carry the last class's cues forward → tap one
// to edit it → tick one off → find the same cue on the class page, because the
// plan is a view over
// the class's own notes, not a copy of them.
//
// Owns its teacher outright (created here, deleted in afterAll) rather than
// borrowing a shared seeded one: it books classes and writes notes, and the
// shared fixtures are read-only.
applyE2ESkipGuards({ extended: true });

const RUN = randomUUID().slice(0, 8);
const TEACHER_ID = randomUUID();
const TEACHER_EMAIL = `day-plan-${RUN}@spiralclass.test`;
const STUDENT_NAME = `Nina ${RUN}`;
const TZ = "America/Mexico_City";

// A Wednesday well clear of anything else the suite books. UTC times chosen to
// fall on the same wall-clock day in Mexico City: 09:00, 11:00, and the week
// before at 09:00.
const DAY = "2027-06-16";
const FIRST = { start: "2027-06-16T15:00:00Z", end: "2027-06-16T15:50:00Z" };
const SECOND = { start: "2027-06-16T17:00:00Z", end: "2027-06-16T17:50:00Z" };
const PREVIOUS = { start: "2027-06-09T15:00:00Z", end: "2027-06-09T15:50:00Z" };

const CARRIED_CUE = "Estudiar imperfecto del subjuntivo";
const NEW_CUE = "Dar correcciones de la tarea";
const EDITED_CUE = "Estudiar imperfecto del subjuntivo (pág. 8)";

/** A cue line's accessible name starts with its text; the rest is the "editar" hint. */
const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

let firstBookingId = "";

test.beforeAll(async () => {
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, $2, $3, true, now(), now())`,
    TEACHER_ID,
    "Day Plan Teacher",
    TEACHER_EMAIL,
  );
  await prisma.teacher.create({
    data: {
      id: TEACHER_ID,
      email: TEACHER_EMAIL,
      name: "Day Plan Teacher",
      timezone: TZ,
      locale: "es",
      country: "MX",
      bookingSlug: `day-plan-${RUN}`,
      onboardingCompleteAt: new Date(),
    },
  });
  const student = await prisma.student.create({
    data: { email: `nina-${RUN}@spiralclass.test`, name: STUDENT_NAME },
    select: { id: true },
  });
  await prisma.teacherStudent.create({ data: { teacherId: TEACHER_ID, studentId: student.id } });
  // Fully committed: the previous class (taught) plus today's two (booked).
  const pkg = await prisma.package.create({
    data: {
      teacherId: TEACHER_ID,
      studentId: student.id,
      classesTotal: 3,
      classesUsed: 3,
      classDurationMin: 50,
      pricePaidMinorUnits: 150_000,
      purchasedAt: new Date("2027-06-01T00:00:00Z"),
      status: "active",
    },
    select: { id: true },
  });
  const book = (slot: { start: string; end: string }, status: "scheduled" | "completed") =>
    prisma.booking.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        packageId: pkg.id,
        scheduledStart: new Date(slot.start),
        scheduledEnd: new Date(slot.end),
        status,
      },
      select: { id: true },
    });
  const previous = await book(PREVIOUS, "completed");
  firstBookingId = (await book(FIRST, "scheduled")).id;
  await book(SECOND, "scheduled");
  await prisma.lessonNote.create({
    data: {
      bookingId: previous.id,
      teacherId: TEACHER_ID,
      audience: "teacher",
      body: CARRIED_CUE,
      position: 0,
    },
  });
});

test.afterAll(async () => {
  // Best-effort, children first; a fresh E2E database is built every run, so
  // a leftover row costs nothing beyond this run.
  const prisma = getPrisma();
  await prisma.booking.deleteMany({ where: { teacherId: TEACHER_ID } }).catch(() => {});
  await prisma.package.deleteMany({ where: { teacherId: TEACHER_ID } }).catch(() => {});
  await prisma.teacherStudent.deleteMany({ where: { teacherId: TEACHER_ID } }).catch(() => {});
  await prisma.student
    .deleteMany({ where: { email: `nina-${RUN}@spiralclass.test` } })
    .catch(() => {});
  await prisma.teacher.delete({ where: { id: TEACHER_ID } }).catch(() => {});
});

test("plan a day: see each class, write a cue, carry one forward, tick it off", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInAsViaOtp(page, TEACHER_EMAIL, `/dashboard/classes/plan?d=${DAY}`);
  await expect(page).toHaveURL(/\/dashboard\/classes\/plan/, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { level: 1, name: "Planificación del día" }),
  ).toBeVisible();

  const first = page.getByRole("region", { name: new RegExp(`^${STUDENT_NAME}, 0?9:00`) });
  const second = page.getByRole("region", { name: new RegExp(`^${STUDENT_NAME}, 11:00`) });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();

  // Only the class that spends the package's last credit is flagged.
  await expect(second.getByText("Última clase del paquete")).toBeVisible();
  await expect(first.getByText("Última clase del paquete")).toHaveCount(0);

  // ---- write a cue; it lands on THIS page (the action refreshes the plan) ----
  await first.getByRole("textbox", { name: `Nuevo punto para ${STUDENT_NAME}` }).fill(NEW_CUE);
  await first.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(first.getByRole("checkbox", { name: `Hecho: ${NEW_CUE}` })).toBeVisible({
    timeout: 15_000,
  });

  // ---- carry last class's cue forward ----
  await first.getByRole("button", { name: "Copiar de la clase anterior" }).click();
  await expect(first.getByRole("checkbox")).toHaveCount(2, { timeout: 15_000 });
  await expect(first.getByRole("listitem").nth(1)).toContainText(CARRIED_CUE);

  // ---- tap a line to edit it; only that line becomes an editor ----
  await first.getByRole("button", { name: startsWith(CARRIED_CUE) }).click();
  const editor = first.getByRole("textbox", { name: "Editar punto" });
  await expect(editor).toHaveValue(CARRIED_CUE);
  await editor.fill(EDITED_CUE);
  await first.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(first.getByRole("button", { name: startsWith(EDITED_CUE) })).toBeVisible({
    timeout: 15_000,
  });
  await expect(first.getByRole("textbox", { name: "Editar punto" })).toHaveCount(0);

  // ---- tick the first cue off ----
  const tick = first.getByRole("checkbox", { name: `Hecho: ${NEW_CUE}` });
  await tick.click();
  await expect(tick).toBeChecked();

  // The plan is the class's own notes: the same cues are on the class page, as
  // private cues, never as something the student sees. Polled, because the
  // tick shows before its write lands.
  await expect
    .poll(
      async () =>
        (
          await getPrisma().lessonNote.findMany({
            where: { bookingId: firstBookingId },
            orderBy: { position: "asc" },
            select: { audience: true, body: true, doneAt: true },
          })
        ).map((n) => [n.audience, n.body, n.doneAt != null]),
      { timeout: 15_000 },
    )
    .toEqual([
      ["teacher", NEW_CUE, true],
      ["teacher", EDITED_CUE, false],
    ]);

  await page.goto(`/dashboard/classes/${firstBookingId}`);
  await expect(page.locator("textarea").filter({ hasText: NEW_CUE }).first()).toBeVisible({
    timeout: 15_000,
  });
});
