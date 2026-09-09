import { describe, expect, it } from "vitest";

import type {
  AdminStats,
  BlockedDate,
  Booking,
  BookingStatus,
  ChatMessage,
  ChatThread,
  LocaleCode,
  Material,
  MaterialAttachmentKind,
  MaterialSendTiming,
  Notification,
  NotificationChannel,
  NotificationStatus,
  PackageTemplate,
  Payment,
  PaymentMethod,
  PaymentStatus,
  SessionUser,
  Slot,
  StripeConnectStatus,
  StudentChatThread,
  StudentProfile,
  StudentSummary,
  Teacher,
  UpdateStudentProfileBody,
  UserRole,
  Weekday,
  WeeklyAvailability,
} from "@spiralclass/shared";

// `@spiralclass/shared` is the wire contract for /api/mobile/* — both apps
// parse against the same types. Even though it's purely a TypeScript surface,
// these compile-time checks catch field drift: removing or renaming a field
// in the shared package will make this file fail to compile.

describe("@spiralclass/shared — wire contract is reachable", () => {
  it("exposes UserRole as a closed string-union", () => {
    const allRoles: UserRole[] = ["teacher", "student", "superuser", "guest"];
    expect(allRoles).toHaveLength(4);
  });

  it("exposes LocaleCode as a closed string-union", () => {
    const all: LocaleCode[] = ["es-MX", "en"];
    expect(all).toHaveLength(2);
  });

  it("Weekday covers 0..6", () => {
    const days: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
    expect(days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("BookingStatus enumerates the wire-stable variants (no DB-side variants)", () => {
    const all: BookingStatus[] = ["scheduled", "completed", "canceled", "no_show", "rescheduled"];
    expect(all).toHaveLength(5);
    // The DB-side variants must NOT leak through the wire.
    const banned = ["canceled_by_student", "canceled_by_teacher"];
    for (const b of banned) {
      expect((all as string[]).includes(b)).toBe(false);
    }
  });

  it("PaymentStatus and PaymentMethod are wire-stable", () => {
    const statuses: PaymentStatus[] = [
      "pending",
      "paid",
      "failed",
      "refunded",
      "partially_refunded",
    ];
    expect(statuses).toHaveLength(5);
    const methods: PaymentMethod[] = ["stripe", "manual_transfer"];
    expect(methods).toHaveLength(2);
  });

  it("StripeConnectStatus is the trio teacher dashboards key off", () => {
    const ss: StripeConnectStatus[] = ["connected", "pending", "disconnected"];
    expect(ss).toHaveLength(3);
  });

  it("MaterialSendTiming covers the four wire-stable variants (class-material send timing)", () => {
    const ts: MaterialSendTiming[] = ["confirmation", "t_5d", "t_24h", "t_1h"];
    expect(ts).toHaveLength(4);
  });

  it("MaterialAttachmentKind has exactly 'file' and 'link'", () => {
    const k: MaterialAttachmentKind[] = ["file", "link"];
    expect(k).toHaveLength(2);
  });

  it("NotificationChannel + Status are minimal", () => {
    const c: NotificationChannel[] = ["push", "email"];
    const s: NotificationStatus[] = ["queued", "sent", "delivered", "failed"];
    expect(c).toHaveLength(2);
    expect(s).toHaveLength(4);
  });

  it("SessionUser shape is the documented one", () => {
    const u: SessionUser = {
      id: "u1",
      email: "a@b.com",
      name: null,
      role: "teacher",
      locale: "es-MX",
      timezone: "America/Mexico_City",
      onboardingComplete: true,
      bookingSlug: "teacher-abc",
      isSuperuser: false,
      isAdmin: false,
    };
    expect(u).toMatchObject({ id: "u1", email: "a@b.com" });
  });

  it("StudentProfile round-trips through UpdateStudentProfileBody", () => {
    const p: StudentProfile = {
      name: "Marco",
      email: "marco@example.com",
      phoneE164: "+5215512345678",
      timezone: "America/Mexico_City",
      nativeLanguage: "en",
    };
    // Every editable field of the profile is expressible in the PATCH body.
    const body: UpdateStudentProfileBody = {
      name: p.name,
      phoneE164: p.phoneE164,
      timezone: p.timezone ?? undefined,
      nativeLanguage: p.nativeLanguage,
    };
    expect(body.name).toBe("Marco");
  });

  it("Booking shape includes ISO strings, IDs, names, duration", () => {
    const b: Booking = {
      id: "b1",
      startsAt: "2026-04-15T15:00:00.000Z",
      endsAt: "2026-04-15T15:50:00.000Z",
      status: "scheduled",
      studentName: "Marco",
      studentId: "s1",
      studentTimezone: "America/Mexico_City",
      teacherName: "Mira",
      teacherId: "t1",
      teacherTimezone: "Europe/London",
      packageId: "p1",
      packageName: "Plan",
      durationMinutes: 50,
      rescheduledFromId: null,
      expiresAt: null,
    };
    expect(b.durationMinutes).toBe(50);
  });

  it("PackageTemplate has separate Stripe + Wise prices and expirationMonths", () => {
    const t: PackageTemplate = {
      id: "tpl1",
      name: "Plan",
      subject: null,
      classCount: 4,
      singleClass: false,
      durationMinutes: 50,
      priceStripeCents: 130_000,
      priceWiseCents: 125_000,
      currency: "MXN",
      expirationMonths: 1,
      active: true,
    };
    expect(t.priceStripeCents).toBe(130_000);
    expect(t.priceWiseCents).toBe(125_000);
  });

  it("Payment.currency is the constant literal 'MXN'", () => {
    const p: Payment = {
      id: "pay1",
      createdAt: "2026-04-15T15:00:00.000Z",
      status: "paid",
      amountCents: 130_000,
      currency: "MXN",
      method: "stripe",
      instrumentKind: null,
      externalRef: "pi_x",
      studentName: "Marco",
      studentId: "s1",
      packageTemplateName: "Plan",
      packageId: "p1",
    };
    expect(p.currency).toBe("MXN");
  });

  it("StudentSummary tolerates a null activePackage", () => {
    const s: StudentSummary = {
      id: "s1",
      name: "Marco",
      email: "m@example.com",
      customPriceCents: null,
      currency: "MXN",
      notLive: false,
      archivedAt: null,
      level: null,
      activePackage: null,
    };
    expect(s.activePackage).toBeNull();
  });

  it("BlockedDate carries inclusive YYYY-MM-DD bounds", () => {
    const b: BlockedDate = { id: "bk1", fromDate: "2026-12-24", toDate: "2026-12-26" };
    expect(b.fromDate <= b.toDate).toBe(true);
  });

  it("WeeklyAvailability carries minute-of-day offsets (not HH:MM)", () => {
    const w: WeeklyAvailability = { weekday: 1, startMinutes: 540, endMinutes: 780 };
    expect(w.endMinutes > w.startMinutes).toBe(true);
  });

  it("AdminStats covers the headline metrics admin/overview keys off", () => {
    const a: AdminStats = {
      teachers: 1,
      teachersOnboarded: 1,
      students: 0,
      activePackages: 0,
      overrides: 0,
      openDisputes: 0,
      grossPaidCents: 0,
      refundsCents: 0,
      notificationsQueued: 0,
      notificationsFailed: 0,
    };
    expect(a).toMatchObject({ teachers: 1 });
  });

  it("Notification.error nullability is preserved", () => {
    const n: Notification = {
      id: "n1",
      templateKey: "class_reminder_24h",
      channel: "push",
      status: "delivered",
      language: "es-MX",
      createdAt: "2026-04-15T15:00:00.000Z",
      error: null,
    };
    expect(n.error).toBeNull();
  });

  it("Teacher carries bookingSlug + wiseEnabled and a stripeStatus union", () => {
    const t: Teacher = {
      id: "t1",
      name: "Mira",
      email: "a@b.com",
      bookingSlug: "teacher-abc",
      timezone: "America/Mexico_City",
      country: "MX",
      stripeStatus: "connected",
      wiseEnabled: true,
      onboardingComplete: true,
      photoUrl: null,
      introVideoUrl: null,
      introVideoDurationMs: null,
    };
    expect(t.wiseEnabled).toBe(true);
  });

  it("Slot is the minimal start/end pair", () => {
    const s: Slot = {
      startsAt: "2026-04-15T15:00:00.000Z",
      endsAt: "2026-04-15T15:50:00.000Z",
    };
    expect(s.startsAt < s.endsAt).toBe(true);
  });

  it("Material can carry a null viewUrl (degraded row)", () => {
    const m: Material = {
      id: "m1",
      label: null,
      attachmentKind: "link",
      viewUrl: null,
      sendTiming: "t_24h",
      createdAt: "2026-04-15T15:00:00.000Z",
    };
    expect(m.viewUrl).toBeNull();
  });

  it("ChatMessage carries senderRole, body (nullable), voice/video fields, ISO dates (readAt nullable)", () => {
    const textMsg: ChatMessage = {
      id: "msg1",
      senderRole: "teacher",
      body: "¡Hola! Tu clase es mañana.",
      replyToId: null,
      replyPreview: null,
      voiceUrl: null,
      voiceDurationMs: null,
      videoUrl: null,
      videoDurationMs: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      fileUrl: null,
      fileName: null,
      fileSizeBytes: null,
      fileMimeType: null,
      createdAt: "2026-06-28T10:00:00.000Z",
      readAt: "2026-06-28T10:05:00.000Z",
      editedAt: "2026-06-28T10:02:00.000Z",
      deletedAt: null,
      reactions: [],
    };
    const voiceMsg: ChatMessage = {
      id: "msg2",
      senderRole: "student",
      body: null,
      replyToId: null,
      replyPreview: null,
      voiceUrl: "https://cdn.example.com/voice.m4a?token=xxx",
      voiceDurationMs: 12_500,
      videoUrl: null,
      videoDurationMs: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      fileUrl: null,
      fileName: null,
      fileSizeBytes: null,
      fileMimeType: null,
      createdAt: "2026-06-28T10:06:00.000Z",
      readAt: null,
      editedAt: null,
      deletedAt: null,
      reactions: [{ role: "teacher", emoji: "👍" }],
    };
    const videoMsg: ChatMessage = {
      id: "msg3",
      senderRole: "student",
      body: null,
      replyToId: null,
      replyPreview: null,
      voiceUrl: null,
      voiceDurationMs: null,
      videoUrl: "https://cdn.example.com/video.mp4?token=yyy",
      videoDurationMs: 8_000,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      fileUrl: null,
      fileName: null,
      fileSizeBytes: null,
      fileMimeType: null,
      createdAt: "2026-06-28T10:07:00.000Z",
      readAt: null,
      editedAt: null,
      deletedAt: null,
      reactions: [],
    };
    // Delete-for-everyone tombstone: content fields all null, deletedAt set.
    const deletedMsg: ChatMessage = {
      id: "msg4",
      senderRole: "teacher",
      body: null,
      replyToId: null,
      replyPreview: null,
      voiceUrl: null,
      voiceDurationMs: null,
      videoUrl: null,
      videoDurationMs: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      fileUrl: null,
      fileName: null,
      fileSizeBytes: null,
      fileMimeType: null,
      createdAt: "2026-06-28T10:08:00.000Z",
      readAt: null,
      editedAt: null,
      deletedAt: "2026-06-28T10:09:00.000Z",
      reactions: [],
    };
    expect(textMsg.editedAt).not.toBeNull();
    expect(deletedMsg.deletedAt).not.toBeNull();
    expect(deletedMsg.body).toBeNull();
    expect(textMsg.senderRole).toBe("teacher");
    expect(voiceMsg.readAt).toBeNull();
    expect(voiceMsg.body).toBeNull();
    expect(voiceMsg.voiceDurationMs).toBe(12_500);
    expect(voiceMsg.reactions).toEqual([{ role: "teacher", emoji: "👍" }]);
    expect(videoMsg.videoUrl).toBe("https://cdn.example.com/video.mp4?token=yyy");
    expect(videoMsg.videoDurationMs).toBe(8_000);
    // senderRole is closed to "teacher" | "student"
    const roles: ChatMessage["senderRole"][] = ["teacher", "student"];
    expect(roles).toHaveLength(2);
  });

  it("ChatThread (teacher view) carries studentId, studentName, unreadCount", () => {
    const thread: ChatThread = {
      studentId: "s1",
      studentName: "Marco López",
      lastMessage: {
        id: "msg1",
        senderRole: "student",
        body: "Hola",
        replyToId: null,
        replyPreview: null,
        voiceUrl: null,
        voiceDurationMs: null,
        videoUrl: null,
        videoDurationMs: null,
        imageUrl: null,
        imageWidth: null,
        imageHeight: null,
        fileUrl: null,
        fileName: null,
        fileSizeBytes: null,
        fileMimeType: null,
        createdAt: "2026-06-28T10:00:00.000Z",
        readAt: null,
        editedAt: null,
        deletedAt: null,
        reactions: [],
      },
      lastMessageKind: "text",
      unreadCount: 3,
    };
    expect(thread.unreadCount).toBe(3);
    expect(thread.lastMessage?.senderRole).toBe("student");
  });

  it("ChatThread names the last message's KIND, since it carries no signed media URL", () => {
    // A thread summary never mints signed URLs (one storage round trip per
    // conversation, to draw a list), so the media fields on `lastMessage` are
    // always null and the kind is what a preview line reads instead.
    const thread: ChatThread = {
      studentId: "s1",
      studentName: "Marco",
      lastMessage: {
        id: "msg1",
        senderRole: "student",
        body: null,
        replyToId: null,
        replyPreview: null,
        voiceUrl: null,
        voiceDurationMs: null,
        videoUrl: null,
        videoDurationMs: null,
        imageUrl: null,
        imageWidth: null,
        imageHeight: null,
        fileUrl: null,
        fileName: null,
        fileSizeBytes: null,
        fileMimeType: null,
        createdAt: "2026-06-28T10:00:00.000Z",
        readAt: null,
        editedAt: null,
        deletedAt: null,
        reactions: [],
      },
      lastMessageKind: "image",
      unreadCount: 1,
    };
    expect(thread.lastMessage?.imageUrl).toBeNull();
    expect(thread.lastMessageKind).toBe("image");
  });

  it("ChatThread.lastMessage can be null when the thread has no messages yet", () => {
    const thread: ChatThread = {
      studentId: "s1",
      studentName: "Marco",
      lastMessage: null,
      lastMessageKind: null,
      unreadCount: 0,
    };
    expect(thread.lastMessage).toBeNull();
    expect(thread.unreadCount).toBe(0);
  });

  it("StudentChatThread (student view) carries teacherId and teacherName", () => {
    const thread: StudentChatThread = {
      teacherId: "t1",
      teacherName: "Mira García",
      studentId: "s1",
      lastMessage: {
        id: "msg1",
        senderRole: "teacher",
        body: "Nos vemos mañana.",
        replyToId: null,
        replyPreview: null,
        voiceUrl: null,
        voiceDurationMs: null,
        videoUrl: null,
        videoDurationMs: null,
        imageUrl: null,
        imageWidth: null,
        imageHeight: null,
        fileUrl: null,
        fileName: null,
        fileSizeBytes: null,
        fileMimeType: null,
        createdAt: "2026-06-28T09:00:00.000Z",
        readAt: null,
        editedAt: null,
        deletedAt: null,
        reactions: [],
      },
      lastMessageKind: "text",
      unreadCount: 1,
    };
    expect(thread.teacherName).toBe("Mira García");
    expect(thread.unreadCount).toBe(1);
  });
});
