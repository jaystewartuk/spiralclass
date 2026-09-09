import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromZonedTime } from "date-fns-tz";

// Blocked dates. The action expands the local YYYY-MM-DD range to the
// teacher's IANA day boundaries, persists the block, then runs the shared
// collision path that cancels + restores any scheduled bookings inside the
// range. Pin: validation, the day-boundary expansion, the create call, the
// canceled-count messaging, and the refusal to duplicate a block that already
// covers the range. The collision logic itself is covered separately, so it's
// stubbed here.

vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));

const state = { canceled: 0 };
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1", timezone: "America/Mexico_City" })),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const blockedDateCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({
  id: "bd1",
}));
const blockedDateDeleteMany = vi.fn(async () => ({ count: 1 }));
// Blocks already on the calendar, as the overlap query would return them.
const existingBlocks: { startsAt: Date; endsAt: Date }[] = [];
const blockedDateFindMany = vi.fn(async () => existingBlocks);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    blockedDate: {
      create: blockedDateCreate,
      deleteMany: blockedDateDeleteMany,
      findMany: blockedDateFindMany,
    },
  },
}));

const notifyBookingsInBlockedRange = vi.fn(async () => ({ canceled: state.canceled }));
vi.mock("@/lib/cancellation/blocked-date-collision", () => ({
  notifyBookingsInBlockedRange,
}));

const { createBlockedDateAction, deleteBlockedDateAction } =
  await import("@/app/actions/blocked-dates");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

/** A whole local day in Mexico City, the zone the mocked teacher is in. */
function localDay(startYmd: string, endYmd: string) {
  return {
    startsAt: fromZonedTime(`${startYmd}T00:00:00`, "America/Mexico_City"),
    endsAt: fromZonedTime(`${endYmd}T23:59:59.999`, "America/Mexico_City"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.canceled = 0;
  existingBlocks.length = 0;
});

describe("createBlockedDateAction", () => {
  it("rejects an invalid date range", async () => {
    const res = await createBlockedDateAction(undefined, fd({ startDate: "", endDate: "" }));
    expect(res).toHaveProperty("error");
    expect(blockedDateCreate).not.toHaveBeenCalled();
  });

  it("expands the range to local day boundaries and persists the block", async () => {
    await createBlockedDateAction(
      undefined,
      fd({ startDate: "2026-07-01", endDate: "2026-07-03", reason: "Vacaciones" }),
    );
    expect(blockedDateCreate).toHaveBeenCalledTimes(1);
    const data = blockedDateCreate.mock.calls[0][0].data as {
      teacherId: string;
      startsAt: Date;
      endsAt: Date;
      reason: string | null;
    };
    expect(data.teacherId).toBe("t1");
    expect(data.reason).toBe("Vacaciones");
    // Mexico City is UTC-6 in July; local midnight → 06:00Z, end-of-day →
    // next-day 05:59:59.999Z.
    expect(data.startsAt.toISOString()).toBe("2026-07-01T06:00:00.000Z");
    expect(data.endsAt.toISOString()).toBe("2026-07-04T05:59:59.999Z");
  });

  it("returns a success message reporting canceled classes", async () => {
    state.canceled = 2;
    const res = await createBlockedDateAction(
      undefined,
      fd({ startDate: "2026-07-01", endDate: "2026-07-01", reason: "" }),
    );
    expect(res?.ok).toMatch(/2/);
    expect(revalidatePath).toHaveBeenCalledWith("/settings/blocked-dates");
  });

  it("still confirms when nothing was canceled", async () => {
    // It used to return `undefined` here, which the form could not tell apart
    // from "no action has run yet" — so a block with no classes in it landed
    // with no feedback at all.
    const res = await createBlockedDateAction(
      undefined,
      fd({ startDate: "2026-07-01", endDate: "2026-07-03", reason: "" }),
    );
    expect(res?.ok).toMatch(/3/);
    expect(res?.error).toBeUndefined();
  });

  it("refuses a range one existing block already covers", async () => {
    existingBlocks.push(localDay("2026-07-01", "2026-07-31"));
    const res = await createBlockedDateAction(
      undefined,
      fd({ startDate: "2026-07-10", endDate: "2026-07-12", reason: "" }),
    );
    expect(res?.error).toBeTruthy();
    expect(blockedDateCreate).not.toHaveBeenCalled();
  });

  it("refuses a range two adjacent blocks cover between them", async () => {
    // Neither block covers it alone, which is why the guard is a sweep over
    // days rather than a single containment query.
    existingBlocks.push(localDay("2026-07-01", "2026-07-05"), localDay("2026-07-06", "2026-07-10"));
    const res = await createBlockedDateAction(
      undefined,
      fd({ startDate: "2026-07-03", endDate: "2026-07-08", reason: "" }),
    );
    expect(res?.error).toBeTruthy();
    expect(blockedDateCreate).not.toHaveBeenCalled();
  });

  it("allows a range that overlaps an existing block but extends past it", async () => {
    existingBlocks.push(localDay("2026-07-01", "2026-07-05"));
    const res = await createBlockedDateAction(
      undefined,
      fd({ startDate: "2026-07-04", endDate: "2026-07-08", reason: "" }),
    );
    expect(res?.error).toBeUndefined();
    expect(blockedDateCreate).toHaveBeenCalledTimes(1);
  });
});

describe("deleteBlockedDateAction", () => {
  it("deletes only the teacher's own row", async () => {
    await deleteBlockedDateAction(fd({ id: "bd1" }));
    expect(blockedDateDeleteMany).toHaveBeenCalledWith({
      where: { id: "bd1", teacherId: "t1" },
    });
  });

  it("is a no-op for a missing id", async () => {
    await deleteBlockedDateAction(fd({}));
    expect(blockedDateDeleteMany).not.toHaveBeenCalled();
  });
});
