import { beforeEach, describe, expect, it, vi } from "vitest";

// Cursor-based pagination for the inbox read-model. The list queries fetch
// PAGE_SIZE + 1 rows and, when the extra row comes back, slice it off and hand
// the last kept row's id back as `nextCursor`. The thin array wrappers
// (listTeacherInbox) keeps returning just the items so
// their existing callers are unaffected.

const findManyArgs: Array<Record<string, unknown>> = [];
const countArgs: Array<Record<string, unknown>> = [];
const updateManyArgs: Array<Record<string, unknown>> = [];

// A deterministic page of notification rows. The route asks for take+1 rows;
// the mock returns whatever slice the test seeds in `state.rows`.
const state = {
  rows: [] as Array<Record<string, unknown>>,
};

const bookingFindMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);
const paymentFindMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);
const packageFindMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);

const studentFindMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: {
      findUnique: vi.fn(async () => ({ name: "Mira", timezone: "America/Mexico_City" })),
      findMany: vi.fn(async () => [{ id: "t1", name: "Mira", timezone: "America/Mexico_City" }]),
    },
    student: { findMany: studentFindMany },
    notification: {
      findMany: vi.fn(async (a: Record<string, unknown>) => {
        findManyArgs.push(a);
        return state.rows;
      }),
      count: vi.fn(async (a: Record<string, unknown>) => {
        countArgs.push(a);
        return 0;
      }),
      updateMany: vi.fn(async (a: Record<string, unknown>) => {
        updateManyArgs.push(a);
        return { count: 0 };
      }),
    },
    booking: { findMany: bookingFindMany },
    payment: { findMany: paymentFindMany },
    package: { findMany: packageFindMany },
  },
}));

// Render each row to a stable item, recording the ctx it was called with so
// tests can assert which zone/locale a row was rendered in.
const renderInboxItemCalls: Array<{ row: { id: string }; ctx: Record<string, unknown> }> = [];

// How many renders were in flight at once. renderInboxItem still issues its own
// queries for templates whose booking isn't reachable from the notification's
// columns, so the page's render fan-out has to stay under the Prisma pool
// (connection_limit=10) — see INBOX_RENDER_CONCURRENCY.
const probe = { inFlight: 0, peak: 0 };
vi.mock("@/lib/notifications/inbox", () => ({
  INBOX_VISIBLE_TEMPLATE_NAMES: ["x"],
  renderInboxItem: vi.fn(
    async (_p: unknown, row: { id: string; createdAt: Date }, ctx: Record<string, unknown>) => {
      renderInboxItemCalls.push({ row, ctx });
      probe.inFlight++;
      probe.peak = Math.max(probe.peak, probe.inFlight);
      // A real await, so overlapping renders actually overlap and the peak
      // measures something. A bare async return resolves in one microtask and
      // would read as concurrency 1 no matter how the caller batches.
      await new Promise((resolve) => setTimeout(resolve, 0));
      probe.inFlight--;
      return {
        id: row.id,
        templateName: "x",
        title: `t-${row.id}`,
        body: "",
        href: null,
        deepLink: `t/messages/peer-${row.id}`,
        deepLinkName: `peer ${row.id}`,
        read: false,
        createdAt: row.createdAt,
      };
    },
  ),
}));

const {
  listTeacherInbox,
  listTeacherInboxPage,
  getTeacherInboxUnreadCount,
  markAllTeacherNotificationsRead,
  inboxWindowStart,
  INBOX_RETENTION_DAYS,
} = await import("@/lib/notifications/inbox-queries");

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    teacherId: "t1",
    templateName: "x",
    bookingId: null,
    paymentId: null,
    metadata: null,
    readAt: null,
    createdAt: new Date(2026, 0, 1, 0, 0, n - i),
  }));
}

beforeEach(() => {
  findManyArgs.length = 0;
  countArgs.length = 0;
  updateManyArgs.length = 0;
  state.rows = [];
  renderInboxItemCalls.length = 0;
  probe.inFlight = 0;
  probe.peak = 0;
  vi.clearAllMocks();
  bookingFindMany.mockResolvedValue([]);
  paymentFindMany.mockResolvedValue([]);
  packageFindMany.mockResolvedValue([]);
  studentFindMany.mockResolvedValue([]);
});

describe("listTeacherInboxPage", () => {
  it("returns nextCursor when an extra row signals more pages", async () => {
    // take=3 → query fetches 4; 4 returned means there IS a next page.
    state.rows = rows(4);
    const page = await listTeacherInboxPage("t1", "es-MX", { take: 3 });
    expect(page.items.map((i) => i.id)).toEqual(["n0", "n1", "n2"]);
    expect(page.nextCursor).toBe("n2");
    // It over-fetches by one.
    expect(findManyArgs[0].take).toBe(4);
  });

  it("returns nextCursor=null on the last page", async () => {
    state.rows = rows(2);
    const page = await listTeacherInboxPage("t1", "es-MX", { take: 3 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("seeks past a cursor with skip:1", async () => {
    state.rows = rows(1);
    await listTeacherInboxPage("t1", "es-MX", { take: 3, cursor: "n5" });
    expect(findManyArgs[0].cursor).toEqual({ id: "n5" });
    expect(findManyArgs[0].skip).toBe(1);
  });

  it("omits cursor/skip on the first page", async () => {
    state.rows = rows(1);
    await listTeacherInboxPage("t1", "es-MX", { take: 3 });
    expect(findManyArgs[0].cursor).toBeUndefined();
    expect(findManyArgs[0].skip).toBeUndefined();
  });

  // The "Unread" view narrows in SQL, not by filtering the rendered page.
  // Filtering afterwards would return however many of the newest fifty rows
  // happened to be unread — an "Unread" tab that shows three of a teacher's
  // forty unread notifications and then claims there are no more.
  it("narrows to unread rows in the WHERE clause", async () => {
    state.rows = rows(1);
    await listTeacherInboxPage("t1", "es-MX", { take: 3, unreadOnly: true });
    expect(findManyArgs[0].where).toMatchObject({ readAt: null });
  });

  it("leaves read rows in by default", async () => {
    state.rows = rows(1);
    await listTeacherInboxPage("t1", "es-MX", { take: 3 });
    expect(findManyArgs[0].where).not.toHaveProperty("readAt");
  });

  it("keeps the retention window and the template filter when unread-only", async () => {
    state.rows = rows(1);
    await listTeacherInboxPage("t1", "es-MX", { take: 3, unreadOnly: true });
    const where = findManyArgs[0].where as Record<string, unknown>;
    expect(where).toMatchObject({
      teacherId: "t1",
      recipientType: "teacher",
      templateName: { in: ["x"] },
    });
    expect(where.createdAt).toBeDefined();
  });

  it("pages the unread view the same way as the full one", async () => {
    state.rows = rows(4);
    const page = await listTeacherInboxPage("t1", "es-MX", {
      take: 3,
      unreadOnly: true,
      cursor: "n9",
    });
    expect(page.nextCursor).toBe("n2");
    expect(findManyArgs[0].cursor).toEqual({ id: "n9" });
    expect(findManyArgs[0].skip).toBe(1);
  });
});

describe("listTeacherInbox (array wrapper)", () => {
  it("returns only the items, unchanged for existing callers", async () => {
    state.rows = rows(2);
    const items = await listTeacherInbox("t1", "es-MX");
    expect(Array.isArray(items)).toBe(true);
    expect(items.map((i) => i.id)).toEqual(["n0", "n1"]);
  });
});

// Perf follow-up #3: payment/package template rows used to each fire their
// own payment.findFirst / package.findFirst inside buildVariables. A page
// mixing several such rows must now collapse to exactly one payment.findMany
// and one package.findMany, mirroring the booking preload's own N+1 fix.
describe("listTeacherInboxPage — payment/package batch preload", () => {
  it("issues one payment.findMany and one package.findMany regardless of row count", async () => {
    state.rows = [
      {
        id: "n0",
        teacherId: "t1",
        templateName: "payment_received",
        bookingId: null,
        paymentId: "pay-1",
        metadata: null,
        readAt: null,
        createdAt: new Date(),
      },
      {
        id: "n1",
        teacherId: "t1",
        templateName: "payment_received",
        bookingId: null,
        paymentId: "pay-2",
        metadata: null,
        readAt: null,
        createdAt: new Date(),
      },
      {
        id: "n2",
        teacherId: "t1",
        templateName: "package_expiry_nudge",
        bookingId: null,
        paymentId: null,
        metadata: { packageId: "pkg-1" },
        readAt: null,
        createdAt: new Date(),
      },
      {
        id: "n3",
        teacherId: "t1",
        templateName: "package_consumed_student",
        bookingId: null,
        paymentId: null,
        metadata: { packageId: "pkg-2" },
        readAt: null,
        createdAt: new Date(),
      },
      {
        id: "n4",
        teacherId: "t1",
        templateName: "booking_confirmation",
        bookingId: "book-1",
        paymentId: null,
        metadata: null,
        readAt: null,
        createdAt: new Date(),
      },
    ];
    bookingFindMany.mockResolvedValue([
      {
        id: "book-1",
        teacherId: "t1",
        packageId: "pkg-3",
        scheduledStart: new Date(),
        scheduledEnd: new Date(),
        status: "scheduled",
      },
    ]);

    await listTeacherInboxPage("t1", "es-MX", { take: 10 });

    expect(paymentFindMany).toHaveBeenCalledTimes(1);
    const paymentArgs = paymentFindMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect(paymentArgs.where).toEqual({ id: { in: ["pay-1", "pay-2"] } });

    expect(packageFindMany).toHaveBeenCalledTimes(1);
    const packageArgs = packageFindMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect(new Set(packageArgs.where.id.in)).toEqual(new Set(["pkg-1", "pkg-2", "pkg-3"]));
  });

  it("no payment/package-templated rows → neither query fires", async () => {
    state.rows = rows(2); // templateName "x", no paymentId/bookingId/metadata
    await listTeacherInboxPage("t1", "es-MX");
    expect(paymentFindMany).not.toHaveBeenCalled();
    expect(packageFindMany).not.toHaveBeenCalled();
  });
});

// Inbox retention window. The inbox read-model shows only the last
// INBOX_RETENTION_DAYS of notifications: before this, the list was an
// unbounded cursor walk over a recipient's entire history, so an inbox only
// ever grew (three pre-class reminders per class per side compound fast).
//
// The window is a *visibility* filter, never a delete — the rows behind it are
// the delivery record (status/error/providerMessageId) that poll-push-receipts
// and support lookups read back. These tests pin both halves of that: the
// read-model is windowed, and the write paths are not.
describe("inbox retention window", () => {
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

  // The floor is computed at call time from the real clock, so assert the
  // captured value is a ~90-day-old Date rather than an exact instant.
  function expectWindowFloor(where: unknown) {
    const createdAt = (where as { createdAt?: { gte?: unknown } }).createdAt;
    expect(createdAt?.gte).toBeInstanceOf(Date);
    const age = Date.now() - (createdAt!.gte as Date).getTime();
    expect(Math.abs(age - NINETY_DAYS_MS)).toBeLessThan(10_000);
  }

  it("inboxWindowStart is exactly INBOX_RETENTION_DAYS × 24h before now", () => {
    expect(INBOX_RETENTION_DAYS).toBe(90);
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(inboxWindowStart(now).toISOString()).toBe("2026-05-03T12:00:00.000Z");
    expect(now.getTime() - inboxWindowStart(now).getTime()).toBe(NINETY_DAYS_MS);
  });

  it("listTeacherInboxPage floors the query at the window", async () => {
    state.rows = rows(1);
    await listTeacherInboxPage("t1", "es-MX");
    expectWindowFloor(findManyArgs[0].where);
  });

  // The badge and the list must agree on which rows count. An unwindowed count
  // over a windowed list is a badge showing unread items the list will never
  // render — a stuck number the recipient has no way to clear.
  it("getTeacherInboxUnreadCount uses the same window as the list", async () => {
    await getTeacherInboxUnreadCount("t1");
    expectWindowFloor(countArgs[0].where);

    state.rows = rows(1);
    await listTeacherInboxPage("t1", "es-MX");
    const countFloor = (countArgs[0].where as { createdAt: { gte: Date } }).createdAt.gte;
    const listFloor = (findManyArgs[0].where as { createdAt: { gte: Date } }).createdAt.gte;
    expect(Math.abs(countFloor.getTime() - listFloor.getTime())).toBeLessThan(10_000);
  });

  // Deliberate asymmetry, not an oversight: windowing the mark-read writes
  // would strand any row that ages out while still unread at readAt: null
  // forever. The reads are windowed; the writes sweep everything.
  it("markAllTeacherNotificationsRead is NOT windowed", async () => {
    await markAllTeacherNotificationsRead("t1");
    expect(updateManyArgs[0].where).not.toHaveProperty("createdAt");
  });
});

// A full 50-row page used to render through one `Promise.all(pageRows.map(...))`,
// opening up to 50 concurrent renders against a Prisma pool of 10
// (connection_limit=10, pool_timeout=10). The tail of the page then died on
// "Timed out fetching a new connection from the connection pool", thrown at
// `Promise.all (index 25)` on GET /notifications — Sentry AGENDAPROFE-1W and
// its three siblings. Rendering in bounded batches is the fix; these tests pin
// the bound and the ordering it has to preserve.
describe("inbox render fan-out", () => {
  it("never renders a full page more than INBOX_RENDER_CONCURRENCY at a time", async () => {
    state.rows = rows(50);
    await listTeacherInboxPage("t1", "es-MX", { take: 50 });
    expect(renderInboxItemCalls).toHaveLength(50);
    expect(probe.peak).toBeLessThanOrEqual(5);
    // Guard the opposite failure: a fully serial loop would also satisfy the
    // cap, and would make a 50-row inbox 50 round-trips deep.
    expect(probe.peak).toBeGreaterThan(1);
  });

  it("preserves row order across batch boundaries", async () => {
    // 12 rows spans three batches, so an out-of-order concat would show up.
    state.rows = rows(12);
    const page = await listTeacherInboxPage("t1", "es-MX", { take: 12 });
    expect(page.items.map((i) => i.id)).toEqual(rows(12).map((r) => r.id));
  });
});
