import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";

// These modules reach `@/lib/homework/wire`, which is a server module
// (`import "server-only"`); neutralize the guard, same as
// homework-wire.test.ts and handlers-content-save.test.ts.
vi.mock("server-only", () => ({}));

// The page tree pulls these server actions in at module scope (they reach
// prisma/next-cache/server-only). Nothing here renders or invokes them, so
// stub the modules out entirely — same approach as
// admin-forms-inline-validation.test.tsx.
vi.mock("@/app/actions/booking-library-materials", () => ({}));
vi.mock("@/app/actions/call-nudge", () => ({}));
vi.mock("@/app/actions/cancel-booking", () => ({}));
vi.mock("@/app/actions/homework", () => ({}));
vi.mock("@/app/actions/lesson-insights", () => ({}));
vi.mock("@/app/actions/lesson-notes", () => ({}));
vi.mock("@/app/actions/library", () => ({}));
vi.mock("@/app/actions/overrides", () => ({}));
vi.mock("@/app/actions/reschedule-booking", () => ({}));

// /dashboard/classes/[bookingId] — pins the QUERY SHAPE of the teacher
// class-detail page, not its markup. Companion to the student-side
// equivalent in tests/student/class-detail-page-queries.test.ts.
//
// This was the slowest transaction on the site (~3.5s avg in Sentry). Unlike
// the student page, EVERY id this route needs is known on entry: `bookingId`
// comes from the route param and `teacherId` from the authenticated teacher,
// never from the booking row. Five queries were nonetheless chained behind
// the booking query, each paying its own round trip (BEGIN + query + COMMIT
// + DEALLOCATE ALL) for ids it already had.
//
// The first test holds the booking query open and asserts the siblings have
// ALREADY been issued, so an await-per-query rewrite cannot pass it.

const BOOKING_ID = "bk_1";
const TEACHER = {
  id: "t1",
  name: "Mira",
  timezone: "America/Mexico_City",
  targetLanguage: "en",
  autoSurfaceLevelMaterials: true,
};

let resolveBooking: (value: unknown) => void = () => {};
const bookingFindFirst = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  () =>
    new Promise((resolve) => {
      resolveBooking = resolve;
    }),
);
const assignmentFindMany = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const libraryMaterialFindMany = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const overrideFindMany = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const teacherStudentFindUnique = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null);
const getClassContentForBooking = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findFirst: (...a: unknown[]) => bookingFindFirst(...a) },
    assignment: { findMany: (...a: unknown[]) => assignmentFindMany(...a) },
    libraryMaterial: { findMany: (...a: unknown[]) => libraryMaterialFindMany(...a) },
    override: { findMany: (...a: unknown[]) => overrideFindMany(...a) },
    teacherStudent: { findUnique: (...a: unknown[]) => teacherStudentFindUnique(...a) },
  },
}));

vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: async () => TEACHER }));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "es-MX",
  getT: async () => (k: string) => k,
}));
// AI on, so the focus-groups branch actually dispatches in the first wave.
vi.mock("@/lib/env", () => ({ hasAnthropicCreds: () => true }));
vi.mock("@/lib/captions/config", () => ({ liveCaptionsEnabled: () => false }));
vi.mock("@/lib/focus-tags", () => ({ getTeacherFocusGroups: async () => [] }));
vi.mock("@/lib/levels", () => ({
  getTeacherLevels: async () => [],
  libraryBrowseWhere: () => ({}),
}));
vi.mock("@/lib/materials/handlers", () => ({
  getClassContentForBooking: (...a: unknown[]) => getClassContentForBooking(...a),
}));
vi.mock("@/lib/storage/provider", () => ({ getStorageProvider: () => null }));
vi.mock("@/lib/storage/signed-urls", () => ({ pickMaterialsUrl: async () => null }));
vi.mock("@/lib/lesson-notes/speaking-time", () => ({ computeSpeakingTime: () => null }));
vi.mock("@/lib/lesson-notes/brief-service", () => ({ getOrGenerateBrief: async () => null }));
vi.mock("@/lib/lesson-notes/brief", () => ({ generateBrief: async () => null }));

// A missing/foreign booking short-circuits via notFound(), which lets every
// test here stop right after the first wave without rendering any JSX.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// Import the module graph ONCE, before any timing-sensitive assertion.
// Doing it inside the test put vitest's transform of the whole page tree
// inside the timing window itself, so the first wave got
// asserted before the function had even started — zero calls, then the
// real calls landing in whichever test happened to run next.
let pageFn: (a: { params: Promise<{ bookingId: string }> }) => Promise<unknown>;
beforeAll(async () => {
  pageFn = (await import("@/app/(app)/dashboard/classes/[bookingId]/page")).default;
});

function runPageUntilNotFound() {
  return pageFn({ params: Promise.resolve({ bookingId: BOOKING_ID }) });
}

// Wait until the first wave has been DISPATCHED, rather than guessing at a
// fixed delay. `Promise.all([a(), b(), c()])` evaluates its arguments
// synchronously, so the instant the booking query is called its siblings
// must already have been called too — which is exactly the property under
// test. If a sibling were moved back behind `await booking`, it would still
// be uncalled at this point and the assertions below fail.
async function waitForFirstWave() {
  for (let i = 0; i < 400 && bookingFindFirst.mock.calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("teacher class-detail page query shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues all five sibling queries WITHOUT waiting for the booking query", async () => {
    const pending = runPageUntilNotFound().catch(() => "not-found");
    await waitForFirstWave();

    // Booking still pending — nothing downstream of it could have run. Each
    // of these keys only off bookingId and/or the authenticated teacher id.
    expect(bookingFindFirst).toHaveBeenCalledTimes(1);
    expect(assignmentFindMany).toHaveBeenCalledTimes(1);
    expect(getClassContentForBooking).toHaveBeenCalledTimes(1);
    expect(libraryMaterialFindMany).toHaveBeenCalledTimes(1);
    expect(overrideFindMany).toHaveBeenCalledTimes(1);

    resolveBooking(null);
    await expect(pending).resolves.toBe("not-found");
  });

  it("scopes the first-wave queries by the route param, not the booking row", async () => {
    const pending = runPageUntilNotFound().catch(() => "not-found");
    await waitForFirstWave();

    expect(assignmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bookingId: BOOKING_ID, teacherId: TEACHER.id }),
      }),
    );
    expect(getClassContentForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID, teacherId: TEACHER.id }),
    );
    expect(overrideFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ targetId: BOOKING_ID, teacherId: TEACHER.id }),
      }),
    );

    resolveBooking(null);
    await pending;
  });

  it("caps the attach-from-library picker", async () => {
    const pending = runPageUntilNotFound().catch(() => "not-found");
    await waitForFirstWave();

    // Was unbounded: a teacher with a large library paid for every row on
    // every class open. #778 capped the mobile twin at the same number.
    const arg = libraryMaterialFindMany.mock.calls[0][0] as unknown as { take?: number };
    expect(arg.take).toBe(500);

    resolveBooking(null);
    await pending;
  });

  it("keeps the ownership predicate and the join strategy on the booking query", async () => {
    const pending = runPageUntilNotFound().catch(() => "not-found");
    await waitForFirstWave();

    const arg = bookingFindFirst.mock.calls[0][0] as unknown as {
      where: { id: string; teacherId: string };
      relationLoadStrategy?: string;
    };
    // Parallelising must never widen the scope: another teacher's booking
    // still has to miss and 404.
    expect(arg.where).toMatchObject({ id: BOOKING_ID, teacherId: TEACHER.id });
    expect(arg.relationLoadStrategy).toBe("join");

    resolveBooking(null);
    await pending;
  });

  it("reads the teacher/student link once, for both archived state and level", async () => {
    const booking = {
      id: BOOKING_ID,
      status: "scheduled",
      scheduledStart: new Date("2030-01-01T10:00:00Z"),
      scheduledEnd: new Date("2030-01-01T11:00:00Z"),
      teacherId: TEACHER.id,
      student: {
        id: "stu_1",
        name: "Bo",
        email: "b@x.test",
        nativeLanguage: "es",
        timezone: "UTC",
      },
      package: {
        id: "pk_1",
        classesTotal: 10,
        classesUsed: 1,
        expiresAt: null,
        status: "active",
        template: { name: "P" },
      },
      rescheduleOf: null,
      reschedules: [],
      materials: [],
      libraryMaterials: [],
      lessonNotes: [],
      lessonSummary: null,
      lessonInsights: [],
      callRecordings: [],
      lessonTranscript: null,
      lessonAudio: null,
    };

    const pending = runPageUntilNotFound().catch(() => "rendered-or-threw");
    await waitForFirstWave();
    resolveBooking(booking);
    await pending;

    // archivedAt and levelId used to come from two separate findUnique calls
    // against the very same row.
    expect(teacherStudentFindUnique).toHaveBeenCalledTimes(1);
    const arg = teacherStudentFindUnique.mock.calls[0][0] as unknown as {
      select: Record<string, boolean>;
    };
    expect(arg.select).toMatchObject({ archivedAt: true, levelId: true });
  });
});
