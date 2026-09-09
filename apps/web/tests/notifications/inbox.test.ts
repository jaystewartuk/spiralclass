import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  INBOX_VISIBLE_TEMPLATE_NAMES,
  isInboxVisibleTemplate,
  renderInboxItem,
  type InboxNotificationRow,
} from "@/lib/notifications/inbox";

const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYMENT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const STUDENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Minimal Prisma fake: the only query the templates under test reach is
// payment.findFirst. `paymentPresent: false` simulates a deleted payment so we
// can assert the graceful fallback path.
function fakePrisma(opts: { paymentPresent: boolean }): PrismaClient {
  return {
    payment: {
      findFirst: async () =>
        opts.paymentPresent
          ? {
              id: PAYMENT_ID,
              amountMinorUnits: 50000,
              paymentReference: "AGP-ABC123",
              package: {
                template: { name: "Paquete 10 clases" },
                student: { name: "María González" },
              },
            }
          : null,
    },
  } as unknown as PrismaClient;
}

// Prisma fake for the chat templates: they resolve the counterpart's display
// name and nothing else. `studentPresent: false` simulates an unlinked/deleted
// student so the graceful fallback can be asserted.
function fakeChatPrisma(opts: { studentPresent: boolean }): PrismaClient {
  return {
    student: {
      findFirst: async () => (opts.studentPresent ? { name: "María González" } : null),
    },
  } as unknown as PrismaClient;
}

function row(overrides: Partial<InboxNotificationRow> = {}): InboxNotificationRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    teacherId: TEACHER_ID,
    templateName: "payment_marked_sent_teacher",
    bookingId: null,
    paymentId: PAYMENT_ID,
    metadata: null,
    readAt: null,
    createdAt: new Date("2026-06-16T12:00:00Z"),
    ...overrides,
  };
}

describe("isInboxVisibleTemplate", () => {
  it("hides the sign-in (magic_link) template", () => {
    expect(isInboxVisibleTemplate("magic_link")).toBe(false);
  });

  it("shows teacher payment templates", () => {
    expect(isInboxVisibleTemplate("payment_marked_sent_teacher")).toBe(true);
    expect(isInboxVisibleTemplate("payment_received_teacher")).toBe(true);
  });

  it("rejects unknown template names", () => {
    expect(isInboxVisibleTemplate("not_a_real_template")).toBe(false);
  });

  it("excludes magic_link from the visible-name list but keeps the rest", () => {
    expect(INBOX_VISIBLE_TEMPLATE_NAMES).not.toContain("magic_link");
    expect(INBOX_VISIBLE_TEMPLATE_NAMES).toContain("payment_marked_sent_teacher");
  });
});

describe("renderInboxItem", () => {
  const ctx = {
    teacherName: "Alicia Moreno",
    recipientTimezone: "America/Mexico_City",
    locale: "es-MX" as const,
  };

  it("renders a Wise 'payment marked sent' notification with title, body, and link", async () => {
    const item = await renderInboxItem(fakePrisma({ paymentPresent: true }), row(), ctx);
    expect(item).not.toBeNull();
    expect(item!.title).toBe("Pago Wise enviado");
    expect(item!.body).toContain("María González");
    expect(item!.body).toContain("Paquete 10 clases");
    // The link is the same path the email/push action button uses.
    expect(item!.href).toBe(`/payments/${PAYMENT_ID}`);
    expect(item!.read).toBe(false);
  });

  it("reflects read state from readAt", async () => {
    const item = await renderInboxItem(
      fakePrisma({ paymentPresent: true }),
      row({ readAt: new Date("2026-06-16T13:00:00Z") }),
      ctx,
    );
    expect(item!.read).toBe(true);
  });

  it("renders the English copy when the viewer locale is en", async () => {
    const item = await renderInboxItem(fakePrisma({ paymentPresent: true }), row(), {
      ...ctx,
      locale: "en",
    });
    expect(item!.title).toBe("Wise payment sent");
  });

  it("returns null for hidden templates", async () => {
    const item = await renderInboxItem(
      fakePrisma({ paymentPresent: true }),
      row({ templateName: "magic_link" }),
      ctx,
    );
    expect(item).toBeNull();
  });

  it("falls back to a generic, link-less item when the referenced entity is gone", async () => {
    const item = await renderInboxItem(fakePrisma({ paymentPresent: false }), row(), ctx);
    expect(item).not.toBeNull();
    expect(item!.title).toBe("Notificación");
    expect(item!.href).toBeNull();
    expect(item!.deepLink).toBeNull();
    expect(item!.deepLinkName).toBeNull();
  });

  // Regression: chat templates carry a role-prefixed deep link
  // (`t/messages/<studentId>`) for the mobile router. The inbox used to root
  // that at "/" verbatim, producing a 404 — a message notification the
  // teacher could click but that navigated nowhere useful.
  it("links a message notification at the teacher's conversation page, not the mobile deep link", async () => {
    const item = await renderInboxItem(
      fakeChatPrisma({ studentPresent: true }),
      row({
        templateName: "chat_message_teacher",
        paymentId: null,
        metadata: { studentId: STUDENT_ID, preview: "¿Podemos mover la clase?" },
      }),
      ctx,
    );
    expect(item).not.toBeNull();
    expect(item!.title).toBe("Mensaje de María González");
    expect(item!.body).toBe("¿Podemos mover la clase?");
    expect(item!.href).toBe(`/dashboard/messages/${STUDENT_ID}`);
    // The RAW suffix survives alongside the translated href — it's what the
    // a client maps with its own router.
    expect(item!.deepLink).toBe(`t/messages/${STUDENT_ID}`);
    expect(item!.deepLinkName).toBe("María González");
  });

  it("links a student message notification at the student's conversation page", async () => {
    const item = await renderInboxItem(
      fakeChatPrisma({ studentPresent: true }),
      row({
        templateName: "chat_message",
        paymentId: null,
        metadata: { preview: "See you tomorrow!" },
      }),
      { ...ctx, locale: "en" },
    );
    expect(item).not.toBeNull();
    expect(item!.title).toBe("Message from Alicia Moreno");
    expect(item!.href).toBe(`/my-classes/messages/${TEACHER_ID}`);
  });

  it("still renders a link-less message notification when the student is gone", async () => {
    const item = await renderInboxItem(
      fakeChatPrisma({ studentPresent: false }),
      row({
        templateName: "chat_message_teacher",
        paymentId: null,
        metadata: { studentId: STUDENT_ID, preview: "hola" },
      }),
      ctx,
    );
    expect(item).not.toBeNull();
    expect(item!.href).toBeNull();
  });

  // Guardrail for the templates that were already working: their suffixes are
  // real web paths and must keep passing through untranslated.
  it("leaves a class notification's dashboard link untouched", async () => {
    const item = await renderInboxItem(
      {
        booking: {
          findFirst: async () => ({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            scheduledStart: new Date("2026-06-20T15:00:00Z"),
            scheduledEnd: new Date("2026-06-20T16:00:00Z"),
            student: { name: "María González", timezone: "America/Mexico_City" },
          }),
        },
      } as unknown as PrismaClient,
      row({
        templateName: "booking_created_teacher",
        paymentId: null,
        bookingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      ctx,
    );
    expect(item).not.toBeNull();
    expect(item!.href).toBe("/dashboard/classes/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });
});
