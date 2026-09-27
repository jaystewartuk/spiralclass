import { test, expect } from "@playwright/test";

import {
  applyE2ESkipGuards,
  bookAClass,
  deleteStudentsByEmail,
  getPrisma,
  missingEnv,
} from "./_helpers";

// A written material the teacher attached to a class is READ on the student's
// class page, not handed over as its PDF. The page used to link every such
// material straight to /api/materials/[id]/pdf, so a generated lesson meant to
// be read in the app downloaded as a file instead. The PDF stays, as a second
// action. The answer key never reaches the page (student-class-attachments.ts).

applyE2ESkipGuards({ extended: true });

const created: string[] = [];
const materialIds: string[] = [];

// Best-effort, like every other spec's cleanup: a booked student still has a
// package pointing at them, so deleting them can hit packages_student_id_fkey,
// and a cleanup that throws fails a test whose assertions all passed.
test.afterAll(async () => {
  if (missingEnv.length > 0 || process.env.E2E_EXTENDED !== "1") return;
  await getPrisma()
    .libraryMaterial.deleteMany({ where: { id: { in: materialIds } } })
    .catch(() => undefined);
  await deleteStudentsByEmail(created).catch(() => undefined);
  await getPrisma().$disconnect();
});

test("a written class material opens in the page, with its PDF as a second action", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { studentEmail, bookingId } = await bookAClass(page, context);
  created.push(studentEmail);

  const prisma = getPrisma();
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { teacherId: true },
  });
  const material = await prisma.libraryMaterial.create({
    data: {
      teacherId: booking.teacherId,
      label: "Presente simple",
      contentSource: "ai",
      body: [
        "> [!exercise]",
        "> Completa: Ella (ir) a la escuela.",
        "",
        "> [!answer]",
        "> SECRET-ANSWER-va",
      ].join("\n"),
    },
    select: { id: true },
  });
  materialIds.push(material.id);
  await prisma.bookingLibraryMaterial.create({
    data: { bookingId, libraryMaterialId: material.id, sendTiming: "confirmation" },
  });

  await page.goto(`/my-classes/${bookingId}`);

  // The title opens the text in place — it is not a link anywhere.
  const title = page.getByText("Presente simple", { exact: true });
  await expect(title).toBeVisible();
  await expect(page.getByRole("link", { name: "Presente simple" })).toHaveCount(0);
  await title.click();
  await expect(page.getByText(/Completa: Ella \(ir\) a la escuela/)).toBeVisible();

  await expect(page.getByRole("link", { name: /Descargar PDF/i })).toHaveAttribute(
    "href",
    `/api/materials/${material.id}/pdf`,
  );

  // Cut on the server: not hidden behind a toggle, absent from the document.
  expect(await page.content()).not.toContain("SECRET-ANSWER");
});
