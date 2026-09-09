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

// /my-classes/[bookingId] — pins the QUERY SHAPE of the student class-detail
// page, not its markup.
//
// The page used to chain the class-content material and the homework rows
// behind the booking query even though both scope on the `bookingId` route
// param the page already has, so each one cost a full extra round trip
// (BEGIN + query + COMMIT + DEALLOCATE ALL) for nothing. That is the same
// waterfall #778 removed from the mobile teacher route. Sentry had this page
// at ~2.8s with `BEGIN` alone averaging 25-28ms.
//
// These tests fail if the waterfall comes back: the first one holds the
// booking query open and asserts its two siblings have ALREADY been issued
// while it is still pending. A `await`-per-query rewrite cannot pass it.

const BOOKING_ID = "bk_1";
const IDENTITY_IDS = ["stu_1", "stu_1_linked"];

let resolveBooking: (value: unknown) => void = () => {};
const bookingFindFirst = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  () =>
    new Promise((resolve) => {
      resolveBooking = resolve;
    }),
);
const libraryMaterialFindFirst = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null);
const libraryMaterialFindMany = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const assignmentFindMany = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const overrideFindMany = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const focusTagCategoryFindMany = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const teacherStudentFindUnique = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findFirst: (...a: unknown[]) => bookingFindFirst(...a) },
    libraryMaterial: {
      findFirst: (...a: unknown[]) => libraryMaterialFindFirst(...a),
      findMany: (...a: unknown[]) => libraryMaterialFindMany(...a),
    },
    assignment: { findMany: (...a: unknown[]) => assignmentFindMany(...a) },
    override: { findMany: (...a: unknown[]) => overrideFindMany(...a) },
    focusTagCategory: { findMany: (...a: unknown[]) => focusTagCategoryFindMany(...a) },
    teacherStudent: { findUnique: (...a: unknown[]) => teacherStudentFindUnique(...a) },
  },
}));

vi.mock("@/lib/auth", () => ({ requireStudent: async () => ({ id: "stu_1" }) }));
vi.mock("@/lib/students/identity", () => ({ studentIdentityIds: async () => IDENTITY_IDS }));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "en",
  getT: async () => (k: string) => k,
}));
vi.mock("@/lib/levels", () => ({
  getTeacherLevels: async () => [],
  libraryBrowseWhere: () => ({}),
}));
vi.mock("@/lib/storage/provider", () => ({ getStorageProvider: () => null }));
vi.mock("@/lib/storage/signed-urls", () => ({ pickMaterialsUrl: async () => null }));
vi.mock("@/lib/video/provider", () => ({ getVideoProvider: () => null }));
vi.mock("@/lib/subscriptions/enforce", () => ({ gateProFeature: async () => ({ ok: true }) }));

// A missing/unauthorized booking short-circuits via notFound(), which lets
// every test here stop right after the first wave without rendering any JSX.
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
  pageFn = (await import("@/app/(student)/my-classes/[bookingId]/page")).default;
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

describe("student class-detail page query shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues the bookingId-keyed queries WITHOUT waiting for the booking query", async () => {
    const pending = runPageUntilNotFound().catch(() => "not-found");
    await waitForFirstWave();

    // The booking query has not resolved yet — nothing downstream of it could
    // have run. If either sibling moved back behind it, these fail.
    expect(bookingFindFirst).toHaveBeenCalledTimes(1);
    expect(libraryMaterialFindFirst).toHaveBeenCalledTimes(1);
    expect(assignmentFindMany).toHaveBeenCalledTimes(1);

    resolveBooking(null);
    await expect(pending).resolves.toBe("not-found");
  });

  it("scopes the class-content material by the route param, not the booking row", async () => {
    const pending = runPageUntilNotFound().catch(() => "not-found");
    await waitForFirstWave();

    expect(libraryMaterialFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bookingId: BOOKING_ID }),
      }),
    );

    resolveBooking(null);
    await pending;
  });

  it("scopes homework submissions to the caller's identity set, not booking.studentId", async () => {
    const pending = runPageUntilNotFound().catch(() => "not-found");
    await waitForFirstWave();

    // booking.studentId is unavailable this early; the identity set that
    // authorizes the booking is equivalent, since the booking belongs to one
    // of these identities. Anything wider would leak another student's
    // submission status onto this page.
    const arg = assignmentFindMany.mock.calls[0][0] as unknown as {
      where: { bookingId: string };
      select: { submissions: { where: { studentId: { in: string[] } } } };
    };
    expect(arg.where.bookingId).toBe(BOOKING_ID);
    expect(arg.select.submissions.where.studentId).toEqual({ in: IDENTITY_IDS });

    resolveBooking(null);
    await pending;
  });

  it("keeps the authorization predicate and the join strategy on the booking query", async () => {
    const pending = runPageUntilNotFound().catch(() => "not-found");
    await waitForFirstWave();

    const arg = bookingFindFirst.mock.calls[0][0] as unknown as {
      where: { id: string; studentId: { in: string[] } };
      relationLoadStrategy?: string;
    };
    // Parallelising must never widen the scope: a booking outside the
    // caller's identity set still has to miss and 404.
    expect(arg.where).toMatchObject({ id: BOOKING_ID, studentId: { in: IDENTITY_IDS } });
    // Seven relations collapse to one LATERAL join rather than one round
    // trip each — the other half of this page's round-trip cost.
    expect(arg.relationLoadStrategy).toBe("join");

    resolveBooking(null);
    await pending;
  });

  it("404s without rendering when the booking is outside the identity set", async () => {
    const pending = runPageUntilNotFound();
    await waitForFirstWave();
    resolveBooking(null);

    await expect(pending).rejects.toThrow("NEXT_NOT_FOUND");
    // The siblings were fetched speculatively; they must never reach a render.
    expect(overrideFindMany).not.toHaveBeenCalled();
  });
});
