import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ATTRIBUTION } from "@/lib/analytics/attribution";

// Prisma is module-mocked so this exercises the ledger's own admission rules —
// who is allowed to become a `visit` row — without a database. That decision is
// the whole point of the guard: a crawler carries no `ap_vid` cookie, so the
// 12h dedup below it can never collapse one, and every hit it lets through
// lands as a fresh visit in the number a teacher reads.
const acquisitionEventFindFirst = vi.fn();
const acquisitionEventCreate = vi.fn();
const marketingActivityFindFirst = vi.fn();
const teacherShareGroupFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    acquisitionEvent: {
      findFirst: (...args: unknown[]) => acquisitionEventFindFirst(...args),
      create: (...args: unknown[]) => acquisitionEventCreate(...args),
    },
    marketingActivity: {
      findFirst: (...args: unknown[]) => marketingActivityFindFirst(...args),
      findUnique: vi.fn(),
    },
    teacherShareGroup: {
      findMany: (...args: unknown[]) => teacherShareGroupFindMany(...args),
    },
  },
}));

const { recordBookingPageVisit } = await import("./events");

const BASE = {
  teacherId: "teacher-1",
  attribution: EMPTY_ATTRIBUTION,
  visitorHash: "visitor-hash-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  acquisitionEventFindFirst.mockResolvedValue(null);
  acquisitionEventCreate.mockResolvedValue({ id: "evt-1" });
  marketingActivityFindFirst.mockResolvedValue(null);
  teacherShareGroupFindMany.mockResolvedValue([]);
});

describe("recordBookingPageVisit", () => {
  it("records a visit for a human", async () => {
    await recordBookingPageVisit({ ...BASE, isBot: false });
    expect(acquisitionEventCreate).toHaveBeenCalledTimes(1);
    expect(acquisitionEventCreate.mock.calls[0][0].data).toMatchObject({
      teacherId: "teacher-1",
      kind: "visit",
      visitorHash: "visitor-hash-1",
    });
  });

  it("drops a bot before it reaches the ledger", async () => {
    await recordBookingPageVisit({ ...BASE, isBot: true });
    expect(acquisitionEventCreate).not.toHaveBeenCalled();
  });

  // The guard has to run before the dedup lookup, not after it: a crawler's
  // hit would otherwise still cost a query on the hottest page in the product,
  // for a row that is thrown away regardless.
  it("does not even query when the visitor is a bot", async () => {
    await recordBookingPageVisit({ ...BASE, isBot: true });
    expect(acquisitionEventFindFirst).not.toHaveBeenCalled();
    expect(marketingActivityFindFirst).not.toHaveBeenCalled();
    expect(teacherShareGroupFindMany).not.toHaveBeenCalled();
  });

  // A cookie-less human (blocked storage, first paint before middleware) still
  // counts — only the bot check may exclude, never the absence of a cookie.
  it("still records a human with no visitor cookie", async () => {
    await recordBookingPageVisit({ ...BASE, visitorHash: null, isBot: false });
    expect(acquisitionEventCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing 12h dedup for a returning human", async () => {
    acquisitionEventFindFirst.mockResolvedValue({ id: "seen-already" });
    await recordBookingPageVisit({ ...BASE, isBot: false });
    expect(acquisitionEventCreate).not.toHaveBeenCalled();
  });
});
