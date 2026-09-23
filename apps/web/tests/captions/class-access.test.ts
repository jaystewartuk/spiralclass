import { afterEach, describe, expect, it, vi } from "vitest";

// lib/captions/class-access.ts sat at ~5% line coverage while owning two
// properties that are expensive to get wrong:
//
//   1. WHOSE SPEECH MAY BE CAPTIONED. A student's live speech is recognised
//      by a browser vendor's speech service during an ordinary class, and for
//      a minor that requires a guardian's recorded consent. The gate has to
//      fail CLOSED — a missing pairing row must read as "no consent", never as
//      "sure, go ahead".
//   2. TENANT SCOPING on the booking-language override, which is a write plus
//      an audit row. With no RLS behind it, the `teacherId` in that `where` is
//      the entire boundary.
//
// The module reaches the global prisma singleton rather than taking an
// injectable db, so prisma is mocked here. `captionsConsentOk` and
// `resolveCaptionDirection` stay REAL — they are pure and separately tested,
// and stubbing them would make these tests assert their own fixtures.
//
// `server-only` is neutralized the same way the route tests do it.
vi.mock("server-only", () => ({}));

const teacherStudentFindUnique = vi.hoisted(() => vi.fn());
const bookingFindFirst = vi.hoisted(() => vi.fn());
const bookingUpdate = vi.hoisted(() => vi.fn(async () => ({})));
const overrideCreate = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: { findUnique: teacherStudentFindUnique },
    booking: { findFirst: bookingFindFirst, update: bookingUpdate },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ booking: { update: bookingUpdate }, override: { create: overrideCreate } }),
  },
}));

const trackServerEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent,
  flushAnalytics: vi.fn(async () => {}),
}));

import {
  applyBookingLanguageOverride,
  captionsPublishConsentOk,
  resolveCaptionSession,
} from "@/lib/captions/class-access";

const BOOKING = { teacherId: "t1", studentId: "s1" };

afterEach(() => vi.clearAllMocks());

describe("captionsPublishConsentOk", () => {
  it("always allows the teacher's own mic without a consent lookup", async () => {
    // A teacher has no per-student consent record to check — covered by the
    // ToS and the in-call disclosure instead.
    expect(await captionsPublishConsentOk(BOOKING, "teacher")).toBe(true);
    expect(teacherStudentFindUnique).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the pairing row is missing", async () => {
    // Shouldn't happen for a resolved booking, but "shouldn't happen" is not a
    // permission model. A missing row must never open the mic.
    teacherStudentFindUnique.mockResolvedValue(null);

    expect(await captionsPublishConsentOk(BOOKING, "student")).toBe(false);
  });

  it("denies an adult student with no recorded consent", async () => {
    teacherStudentFindUnique.mockResolvedValue({
      isMinor: false,
      captionsConsentAt: null,
      captionsGuardianConsentAt: null,
    });

    expect(await captionsPublishConsentOk(BOOKING, "student")).toBe(false);
  });

  it("allows an adult student who consented herself", async () => {
    teacherStudentFindUnique.mockResolvedValue({
      isMinor: false,
      captionsConsentAt: new Date(),
      captionsGuardianConsentAt: null,
    });

    expect(await captionsPublishConsentOk(BOOKING, "student")).toBe(true);
  });

  it("does NOT accept a minor's own consent in place of a guardian's", async () => {
    // The whole point of the isMinor split. A regression that collapsed these
    // two columns into one would pass every other test in this file.
    teacherStudentFindUnique.mockResolvedValue({
      isMinor: true,
      captionsConsentAt: new Date(),
      captionsGuardianConsentAt: null,
    });

    expect(await captionsPublishConsentOk(BOOKING, "student")).toBe(false);
  });

  it("allows a minor with guardian consent recorded", async () => {
    teacherStudentFindUnique.mockResolvedValue({
      isMinor: true,
      captionsConsentAt: null,
      captionsGuardianConsentAt: new Date(),
    });

    expect(await captionsPublishConsentOk(BOOKING, "student")).toBe(true);
  });

  it("looks the pairing up by the composite teacher+student key", async () => {
    teacherStudentFindUnique.mockResolvedValue(null);

    await captionsPublishConsentOk(BOOKING, "student");

    expect(teacherStudentFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId_studentId: { teacherId: "t1", studentId: "s1" } },
      }),
    );
  });
});

describe("resolveCaptionSession", () => {
  const bookingRow = (overrides: Record<string, unknown> = {}) => ({
    id: "b1",
    teacherId: "t1",
    studentId: "s1",
    teacherLanguageOverride: null,
    studentLanguageOverride: null,
    teacher: { id: "t1", teachingLanguage: "es", country: "MX" },
    student: { nativeLanguage: "en" },
    ...overrides,
  });
  const TEACHER = { role: "teacher", teacherId: "t1" } as const;
  const STUDENT = { role: "student" as const, studentIds: ["s1", "s1-sibling"] };

  it("returns null for a booking the caller is not a party to", async () => {
    bookingFindFirst.mockResolvedValue(null);
    expect(await resolveCaptionSession("nope", TEACHER)).toBeNull();
  });

  // The tenant boundary: with no RLS, the party filter in this `where` is the
  // only thing between one teacher's session and another teacher's class.
  it("scopes the lookup to the teacher's own bookings", async () => {
    bookingFindFirst.mockResolvedValue(null);
    await resolveCaptionSession("b1", TEACHER);
    expect(bookingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b1", teacherId: "t1" } }),
    );
  });

  it("scopes a student's lookup to every row her sign-in owns", async () => {
    bookingFindFirst.mockResolvedValue(null);
    await resolveCaptionSession("b1", STUDENT);
    expect(bookingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b1", studentId: { in: ["s1", "s1-sibling"] } } }),
    );
  });

  it("resolves both speakers' directions from the parties' default languages", async () => {
    bookingFindFirst.mockResolvedValue(bookingRow());
    teacherStudentFindUnique.mockResolvedValue(null);

    expect(await resolveCaptionSession("b1", TEACHER)).toMatchObject({
      bookingId: "b1",
      role: "teacher",
      teacherIdentity: "t1",
      directions: {
        teacher: { source: "es", target: "en" },
        student: { source: "en", target: "es" },
      },
    });
  });

  it("prefers the per-booking language override over the party's default", async () => {
    // Live-read, never snapshotted — a mid-day change takes effect on the
    // next config poll.
    bookingFindFirst.mockResolvedValue(
      bookingRow({ teacherLanguageOverride: "fr", studentLanguageOverride: "de" }),
    );
    teacherStudentFindUnique.mockResolvedValue(null);

    expect(await resolveCaptionSession("b1", STUDENT)).toMatchObject({
      role: "student",
      directions: {
        teacher: { source: "fr", target: "de" },
        student: { source: "de", target: "fr" },
      },
    });
  });

  it("recognises the teacher in her country's variant and the student in the bare language", async () => {
    bookingFindFirst.mockResolvedValue(bookingRow());
    teacherStudentFindUnique.mockResolvedValue(null);

    expect((await resolveCaptionSession("b1", TEACHER))?.recognitionLocales).toEqual({
      teacher: "es-MX",
      student: "en",
    });
  });

  it("falls back to the bare language for a teacher with no country yet", async () => {
    bookingFindFirst.mockResolvedValue(
      bookingRow({ teacher: { id: "t1", teachingLanguage: "es", country: null } }),
    );
    teacherStudentFindUnique.mockResolvedValue(null);

    expect((await resolveCaptionSession("b1", TEACHER))?.recognitionLocales.teacher).toBe("es");
  });

  it("carries the student consent verdict through, for either caller", async () => {
    bookingFindFirst.mockResolvedValue(bookingRow());
    teacherStudentFindUnique.mockResolvedValue({
      isMinor: false,
      captionsConsentAt: new Date(),
      captionsGuardianConsentAt: null,
    });
    expect(await resolveCaptionSession("b1", TEACHER)).toMatchObject({ studentConsent: true });
    expect(await resolveCaptionSession("b1", STUDENT)).toMatchObject({ studentConsent: true });
  });

  it("reports no consent when the pairing has none", async () => {
    bookingFindFirst.mockResolvedValue(bookingRow());
    teacherStudentFindUnique.mockResolvedValue(null);
    expect(await resolveCaptionSession("b1", TEACHER)).toMatchObject({ studentConsent: false });
  });

  it("offers the phone-to-phone fallback only when its key is configured", async () => {
    bookingFindFirst.mockResolvedValue(bookingRow());
    teacherStudentFindUnique.mockResolvedValue(null);
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-key");
    expect(await resolveCaptionSession("b1", TEACHER)).toMatchObject({ cloudRecognition: true });
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    expect(await resolveCaptionSession("b1", STUDENT)).toMatchObject({ cloudRecognition: false });
    vi.unstubAllEnvs();
  });
});

describe("applyBookingLanguageOverride", () => {
  const input = {
    teacherId: "t1",
    bookingId: "b1",
    teacherLanguage: "fr",
    studentLanguage: "de",
    reason: "student prefers French",
  };

  it("scopes the ownership lookup to the calling teacher", async () => {
    // The tenant boundary. Without teacherId in this where, any authenticated
    // teacher could rewrite any booking's caption languages.
    bookingFindFirst.mockResolvedValue(null);

    await applyBookingLanguageOverride(input);

    expect(bookingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "b1", teacherId: "t1" }),
      }),
    );
  });

  it("returns not-found for another teacher's booking and writes nothing", async () => {
    bookingFindFirst.mockResolvedValue(null);

    expect(await applyBookingLanguageOverride(input)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(bookingUpdate).not.toHaveBeenCalled();
    expect(overrideCreate).not.toHaveBeenCalled();
  });

  it("writes the override and an audit row in the same transaction", async () => {
    bookingFindFirst.mockResolvedValue({
      id: "b1",
      teacherLanguageOverride: null,
      studentLanguageOverride: "es",
    });

    expect(await applyBookingLanguageOverride(input)).toEqual({ ok: true });

    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b1" },
        data: { teacherLanguageOverride: "fr", studentLanguageOverride: "de" },
      }),
    );
    // The audit row must capture BEFORE state, or the trail can't answer
    // "what did this actually change".
    expect(overrideCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          teacherId: "t1",
          targetType: "booking",
          targetId: "b1",
          action: "set_class_language",
          reason: "student prefers French",
          beforeJson: { teacherLanguageOverride: null, studentLanguageOverride: "es" },
          afterJson: { teacherLanguageOverride: "fr", studentLanguageOverride: "de" },
        }),
      }),
    );
  });

  it("supports CLEARING an override with nulls", async () => {
    bookingFindFirst.mockResolvedValue({
      id: "b1",
      teacherLanguageOverride: "fr",
      studentLanguageOverride: "de",
    });

    await applyBookingLanguageOverride({
      ...input,
      teacherLanguage: null,
      studentLanguage: null,
      reason: "back to defaults",
    });

    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { teacherLanguageOverride: null, studentLanguageOverride: null },
      }),
    );
  });

  it("tracks the override for the audit analytics stream", async () => {
    bookingFindFirst.mockResolvedValue({
      id: "b1",
      teacherLanguageOverride: null,
      studentLanguageOverride: null,
    });

    await applyBookingLanguageOverride(input);

    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "override_applied",
        distinctId: "t1",
      }),
    );
  });
});
