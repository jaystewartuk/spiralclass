import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  applyE2ESkipGuards,
  deleteStudentsByEmail,
  getPrisma,
  missingEnv,
  purchaseAndActivatePackage,
  signInAsViaOtp,
  TEACHER_EMAIL,
} from "./_helpers";

// UAT §D — teacher↔student messaging, text leg (§D.text + §D.reply).
//
// The web suite had NO messaging coverage at all before this: the mobile
// Maestro flow (smoke-student-messaging.yaml) only sends one message as the
// student and checks her own bubble renders, so nothing anywhere proved a
// message actually crosses between the two roles.
//
// This asserts the full round trip in BOTH directions, and asserts each leg in
// the database as well as the DOM. That second assertion is load-bearing, not
// belt-and-braces: the composer renders optimistically, so a send whose POST
// failed still paints the bubble — a DOM-only assertion would pass against a
// completely broken send path.
//
// NOT covered here: voice and video messages (§D.voice / §D.voice-play). Those
// need a real MediaRecorder capture plus an R2 upload, so they can't run in the
// hermetic gate without a fake media device and a storage stub — a bigger piece
// of infrastructure than this spec, deliberately left to its own change rather
// than half-faked here.
//
// Gated on E2E_EXTENDED=1 like every journey beyond the happy path.

applyE2ESkipGuards({ extended: true });

const created: string[] = [];

/**
 * The message body inside the OPEN CONVERSATION, not the inbox list beside it.
 *
 * `/dashboard/messages` became a two-pane inbox (#1069), so a message body now
 * appears twice on the teacher's screen: once as the truncated preview on its
 * conversation row, and once as the bubble in the thread. A bare
 * `page.getByText(body)` matches both and fails Playwright's strict mode —
 * which is what it is for, because the two are not interchangeable. This spec
 * is about the thread.
 *
 * Selected as a paragraph rather than by test id because that is the real
 * distinction in the markup and it holds on both sides of the conversation:
 * `MessageBubble` renders a body as `<p class="whitespace-pre-wrap …">`, while
 * `ThreadList` renders its preview as an inline `<span>` inside the row's link.
 */
const messageBody = (page: import("@playwright/test").Page, body: string) =>
  page.locator("p.whitespace-pre-wrap").filter({ hasText: body });

test.describe.serial("teacher ↔ student messaging (§D)", () => {
  test("student sends a message → teacher reads it and replies → student sees the reply", async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    const prisma = getPrisma();
    const runId = randomUUID().slice(0, 8);
    // Distinctive bodies so the DOM assertions can't match seeded chatter.
    const studentText = `Hola profe, pregunta ${runId}`;
    const teacherText = `Respuesta ${runId}`;

    // A purchase is enough — messaging hangs off the teacher↔student link the
    // checkout creates, not off a booking. Skipping the reservation keeps this
    // spec ~40s shorter than reusing bookAClass.
    const { studentEmail, packageId } = await purchaseAndActivatePackage(page, context);
    created.push(studentEmail);

    const pkg = await prisma.package.findUnique({
      where: { id: packageId },
      select: { teacherId: true, studentId: true },
    });
    if (!pkg) throw new Error("no package row after purchase");
    const { teacherId, studentId } = pkg;

    // ---- Student → teacher ----
    await context.clearCookies();
    await signInAsViaOtp(page, studentEmail, "/my-classes/messages");
    await expect(page).toHaveURL(/\/my-classes\/messages/, { timeout: 30_000 });

    // Open the thread by teacher id rather than tapping a row: a freshly
    // purchased student has NO messages yet, and the thread list is derived
    // from the messages table — so there is genuinely no row to tap until this
    // spec has sent something. (The same reason the mobile flow reaches chat
    // via a booking detail instead of the thread list.)
    await page.goto(`/my-classes/messages/${teacherId}`);
    const composer = page.getByPlaceholder(/Escribe un mensaje|Write a message/i);
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.fill(studentText);
    await page.getByRole("button", { name: /Enviar mensaje|Send message/i }).click();

    await expect(messageBody(page, studentText)).toBeVisible({ timeout: 15_000 });
    // The row is what proves the send actually landed (see header).
    await expect
      .poll(
        async () =>
          prisma.message.count({
            where: { teacherId, studentId, senderRole: "student", body: studentText },
          }),
        { timeout: 15_000 },
      )
      .toBe(1);

    // ---- Teacher → student ----
    await context.clearCookies();
    await signInAsViaOtp(page, TEACHER_EMAIL, `/dashboard/messages/${studentId}`);
    await expect(page).toHaveURL(new RegExp(`/dashboard/messages/${studentId}`), {
      timeout: 30_000,
    });
    // The student's message crossed the role boundary — the assertion the
    // mobile flow never makes.
    await expect(messageBody(page, studentText)).toBeVisible({ timeout: 30_000 });

    const teacherComposer = page.getByPlaceholder(/Escribe un mensaje|Write a message/i);
    await expect(teacherComposer).toBeVisible({ timeout: 30_000 });
    await teacherComposer.fill(teacherText);
    await page.getByRole("button", { name: /Enviar mensaje|Send message/i }).click();
    await expect(messageBody(page, teacherText)).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(
        async () =>
          prisma.message.count({
            where: { teacherId, studentId, senderRole: "teacher", body: teacherText },
          }),
        { timeout: 15_000 },
      )
      .toBe(1);

    // ---- Student sees the reply ----
    await context.clearCookies();
    await signInAsViaOtp(page, studentEmail, `/my-classes/messages/${teacherId}`);
    await expect(messageBody(page, teacherText)).toBeVisible({ timeout: 30_000 });

    // Opening the thread marks the teacher's messages read (the page does this
    // on load). This is what drives the chat notification cascade's
    // "delayed email if still unread" branch, so a regression here would
    // silently start emailing students about messages they already read.
    await expect
      .poll(
        async () => {
          const m = await prisma.message.findFirst({
            where: { teacherId, studentId, senderRole: "teacher", body: teacherText },
            select: { readAt: true },
          });
          return m?.readAt !== null && m?.readAt !== undefined;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test.afterAll(async () => {
    if (missingEnv.length > 0 || process.env.E2E_EXTENDED !== "1") return;
    await deleteStudentsByEmail(created).catch(() => undefined);
    await getPrisma().$disconnect();
  });
});
