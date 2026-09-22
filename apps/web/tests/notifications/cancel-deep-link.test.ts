import { describe, expect, it } from "vitest";
import { renderPush } from "@/lib/notifications/push";
import { buildVariables } from "@/lib/notifications/dispatcher";
import type { TemplateName } from "@/lib/notifications/templates";

// The rebook button on a cancellation notice. The canceled booking is no longer
// a valid destination, so the button goes to the student book page, where she
// can pick a new slot from her restored credit.
//
// On a live send it is a single-use sign-in link (`r/re/<token>`,
// lib/auth/notification-link.ts) bound to the booking's own student. Without a
// recipient — the inbox, whose reader is already signed in — it is the book
// page itself, and nothing is issued.

const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STUDENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN_LINK = /^r\/re\/[A-Za-z0-9_-]{43}$/;

function fakePrisma() {
  const issued: Array<{ identifier: string; value: string; expiresAt: Date }> = [];
  const prisma = {
    booking: {
      findFirst: async () => ({
        id: BOOKING_ID,
        packageId: "pkg-1",
        studentId: STUDENT_ID,
        scheduledStart: new Date("2026-07-01T15:00:00Z"),
        scheduledEnd: new Date("2026-07-01T15:50:00Z"),
        teacherId: TEACHER_ID,
      }),
    },
    verification: {
      create: async ({ data }: { data: (typeof issued)[number] }) => {
        issued.push(data);
        return data;
      },
    },
  } as never;
  return { prisma, issued };
}

function build(
  prisma: never,
  templateName: TemplateName,
  signInRecipient?: { studentId: string; email: string | null } | null,
) {
  return buildVariables(prisma, {
    templateName,
    notification: {
      id: "n1",
      teacherId: TEACHER_ID,
      bookingId: BOOKING_ID,
      paymentId: null,
      metadata: null,
    },
    teacherName: "Alicia Moreno",
    recipientTimezone: "America/Costa_Rica",
    recipientLocale: "es",
    storage: null,
    signInRecipient,
  });
}

function suffixOf(result: Awaited<ReturnType<typeof buildVariables>>): string | undefined {
  if (!result.ok) throw new Error(result.reason);
  return (result.variables as { reschedulePathSuffix?: string }).reschedulePathSuffix;
}

describe("renderPush — cancel templates deep-link to book tab via reschedulePathSuffix", () => {
  it("cancel_lt24h uses reschedulePathSuffix when provided", () => {
    const rendered = renderPush("cancel_lt24h", "es", {
      teacherName: "Alicia Moreno",
      originalDateTime: "martes 10:00",
      reschedulePathSuffix: "r/re/token",
    });
    expect(rendered.deepLink).toBe("r/re/token");
  });

  it("cancel_lt24h falls back to null when reschedulePathSuffix is absent", () => {
    const rendered = renderPush("cancel_lt24h", "es", {
      teacherName: "Alicia Moreno",
      originalDateTime: "martes 10:00",
    });
    expect(rendered.deepLink).toBeNull();
  });

  it("teacher_cancel uses reschedulePathSuffix as deepLink", () => {
    const rendered = renderPush("teacher_cancel", "es", {
      teacherName: "Alicia Moreno",
      originalDateTime: "martes 10:00",
      reschedulePathSuffix: "r/re/token",
    });
    expect(rendered.deepLink).toBe("r/re/token");
  });

  it("cancel_gte24h_with_reschedule uses reschedulePathSuffix as deepLink", () => {
    const rendered = renderPush("cancel_gte24h_with_reschedule", "en", {
      teacherName: "Alicia Moreno",
      originalDateTime: "Tuesday 10:00",
      reschedulePathSuffix: "r/re/token",
    });
    expect(rendered.deepLink).toBe("r/re/token");
  });
});

describe("buildVariables — the rebook link on a live send", () => {
  const CANCEL_TEMPLATES: TemplateName[] = [
    "teacher_cancel",
    "cancel_lt24h",
    "cancel_gte24h_with_reschedule",
  ];

  for (const templateName of CANCEL_TEMPLATES) {
    it(`${templateName} carries a single-use token bound to the booking's student`, async () => {
      const { prisma, issued } = fakePrisma();
      const suffix = suffixOf(
        await build(prisma, templateName, { studentId: STUDENT_ID, email: "alumna@example.com" }),
      );

      expect(suffix).toMatch(TOKEN_LINK);
      expect(suffix).not.toContain(BOOKING_ID);
      expect(issued).toHaveLength(1);
      expect(issued[0].identifier).toMatch(/^notification-link:rebook:/);
      expect(JSON.parse(issued[0].value)).toEqual({
        s: STUDENT_ID,
        m: "alumna@example.com",
        x: BOOKING_ID,
      });
    });
  }
});

describe("buildVariables — no sign-in link without its student", () => {
  it("the inbox (no recipient) gets the book page itself and issues nothing", async () => {
    const { prisma, issued } = fakePrisma();
    expect(suffixOf(await build(prisma, "teacher_cancel"))).toBe("my-classes/book?packageId=pkg-1");
    expect(issued).toHaveLength(0);
  });

  it("a recipient the booking does not belong to gets the book page and issues nothing", async () => {
    const { prisma, issued } = fakePrisma();
    const suffix = suffixOf(
      await build(prisma, "teacher_cancel", { studentId: "someone-else", email: "x@example.com" }),
    );
    expect(suffix).toBe("my-classes/book?packageId=pkg-1");
    expect(issued).toHaveLength(0);
  });

  it("a recipient with no email gets the book page and issues nothing", async () => {
    const { prisma, issued } = fakePrisma();
    const suffix = suffixOf(
      await build(prisma, "cancel_lt24h", { studentId: STUDENT_ID, email: null }),
    );
    expect(suffix).toBe("my-classes/book?packageId=pkg-1");
    expect(issued).toHaveLength(0);
  });
});

describe("buildVariables — magic_link", () => {
  function buildMagic(
    prisma: never,
    signInRecipient: { studentId: string; email: string | null } | null,
    expiryMinutes?: number,
  ) {
    return buildVariables(prisma, {
      templateName: "magic_link",
      notification: {
        id: "notif-1",
        teacherId: TEACHER_ID,
        bookingId: null,
        paymentId: null,
        metadata: { magicLinkUrl: "/r/ml/pending", expiryMinutes },
      },
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Costa_Rica",
      recipientLocale: "es",
      storage: null,
      signInRecipient,
    });
  }

  it("issues a single-use token for the notification, and states its real expiry", async () => {
    const { prisma, issued } = fakePrisma();
    const now = Date.now();
    const result = await buildMagic(prisma, { studentId: STUDENT_ID, email: "alumna@example.com" });
    if (!result.ok) throw new Error(result.reason);
    const vars = result.variables as { magicLinkPathSuffix: string; expiryMinutes: string };

    expect(vars.magicLinkPathSuffix).toMatch(/^r\/ml\/[A-Za-z0-9_-]{43}$/);
    expect(vars.magicLinkPathSuffix).not.toContain("notif-1");
    expect(vars.expiryMinutes).toBe("60");
    expect(issued).toHaveLength(1);
    expect(issued[0].identifier).toMatch(/^notification-link:magic-link:/);
    expect(JSON.parse(issued[0].value)).toMatchObject({ s: STUDENT_ID, x: "notif-1" });
    const lifetimeMinutes = (issued[0].expiresAt.getTime() - now) / 60_000;
    expect(lifetimeMinutes).toBeGreaterThan(59);
    expect(lifetimeMinutes).toBeLessThanOrEqual(60.1);
  });

  it("never promises, or issues, longer than an hour", async () => {
    const { prisma } = fakePrisma();
    const result = await buildMagic(
      prisma,
      { studentId: STUDENT_ID, email: "alumna@example.com" },
      24 * 60,
    );
    if (!result.ok) throw new Error(result.reason);
    expect((result.variables as { expiryMinutes: string }).expiryMinutes).toBe("60");
  });

  it("refuses to build without a recipient to bind the link to", async () => {
    const { prisma, issued } = fakePrisma();
    expect(await buildMagic(prisma, null)).toEqual({
      ok: false,
      reason: "magic-link-without-recipient",
    });
    expect(await buildMagic(prisma, { studentId: STUDENT_ID, email: null })).toEqual({
      ok: false,
      reason: "magic-link-without-recipient",
    });
    expect(issued).toHaveLength(0);
  });
});
