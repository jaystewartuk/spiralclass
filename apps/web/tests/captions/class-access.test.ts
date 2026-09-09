import { afterEach, describe, expect, it, vi } from "vitest";

// lib/captions/class-access.ts sat at ~5% line coverage while owning two
// properties that are expensive to get wrong:
//
//   1. WHOSE MIC MAY REACH A THIRD-PARTY ASR PROVIDER. A student's live audio
//      is streamed out during an ordinary class, and for a minor that requires
//      a guardian's recorded consent. The gate has to fail CLOSED — a missing
//      pairing row must read as "no consent", never as "sure, go ahead".
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
  resolveClassCallRoomConfig,
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

describe("resolveClassCallRoomConfig", () => {
  const bookingRow = (overrides: Record<string, unknown> = {}) => ({
    id: "b1",
    teacherId: "t1",
    studentId: "s1",
    teacherLanguageOverride: null,
    studentLanguageOverride: null,
    teacher: { id: "t1", teachingLanguage: "en" },
    student: { nativeLanguage: "es" },
    ...overrides,
  });

  it("returns null for an unknown booking", async () => {
    bookingFindFirst.mockResolvedValue(null);

    expect(await resolveClassCallRoomConfig("nope")).toBeNull();
  });

  it("resolves BOTH directions from the parties' default languages", async () => {
    // The Agent transcribes and translates both sides, so it needs the pair —
    // teacher speaks en→es, student speaks es→en.
    bookingFindFirst.mockResolvedValue(bookingRow());
    teacherStudentFindUnique.mockResolvedValue(null);

    const config = await resolveClassCallRoomConfig("b1");

    expect(config).toMatchObject({
      bookingId: "b1",
      teacherDirection: { source: "en", target: "es" },
      studentDirection: { source: "es", target: "en" },
    });
  });

  it("prefers the per-booking language override over the party's default", async () => {
    // Live-read, never snapshotted — a mid-day language change takes effect on
    // the next join.
    bookingFindFirst.mockResolvedValue(
      bookingRow({ teacherLanguageOverride: "fr", studentLanguageOverride: "de" }),
    );
    teacherStudentFindUnique.mockResolvedValue(null);

    const config = await resolveClassCallRoomConfig("b1");

    expect(config).toMatchObject({
      teacherDirection: { source: "fr", target: "de" },
      studentDirection: { source: "de", target: "fr" },
    });
  });

  it("carries the student consent verdict through to the Agent", async () => {
    bookingFindFirst.mockResolvedValue(bookingRow());
    teacherStudentFindUnique.mockResolvedValue({
      isMinor: false,
      captionsConsentAt: new Date(),
      captionsGuardianConsentAt: null,
    });

    expect(await resolveClassCallRoomConfig("b1")).toMatchObject({
      studentCaptionsAllowed: true,
    });
  });

  it("reports studentCaptionsAllowed false when consent is absent", async () => {
    bookingFindFirst.mockResolvedValue(bookingRow());
    teacherStudentFindUnique.mockResolvedValue(null);

    expect(await resolveClassCallRoomConfig("b1")).toMatchObject({
      studentCaptionsAllowed: false,
    });
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
