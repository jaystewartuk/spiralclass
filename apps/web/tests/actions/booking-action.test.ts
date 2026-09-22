import { beforeEach, describe, expect, it, vi } from "vitest";

// Student-facing createBooking. The slot re-validation + capacity claim live
// in bookPackageSlot (covered separately); this verifies the action shell:
// input validation, auth, disabled-account block, package resolution across
// the identity set, mapping each outcome code to a friendly error, and the
// success redirect.

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn() }));
const trackServerEventMock = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackServerEventMock,
  flushAnalytics: vi.fn(),
}));
vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: vi.fn(async () => ["s1"]),
}));

const state = {
  user: { id: "u1" } as { id: string } | null,
  student: { id: "s1", email: "a@b.com", disabledAt: null as Date | null } as {
    id: string;
    email: string;
    disabledAt: Date | null;
  } | null,
  pkg: {
    id: "pkg1",
    teacherId: "t1",
    templateId: "tmpl1",
    teacher: { id: "t1", name: "Prof. Mira" },
    template: { name: "5 clases de 50 min", singleClass: false },
  } as Record<string, unknown> | null,
  outcome: { code: "ok", bookingId: "bk1" } as { code: string; bookingId?: string },
};

vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => state.user,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    student: { findFirst: vi.fn(async () => state.student) },
    package: { findFirst: vi.fn(async () => state.pkg) },
    // Backs maybeEmitFirstBooking's post-create check
    // — this test isn't about that signal, so any count works.
    booking: { count: vi.fn(async () => 1) },
  },
}));

const bookPackageSlot = vi.fn(async () => state.outcome);
vi.mock("@/lib/booking/book-package-slot", () => ({ bookPackageSlot }));

const { createBooking } = await import("@/app/actions/booking");

const PKG = "11111111-1111-4111-8111-111111111111";
function fd(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("packageId", PKG);
  f.set("startUtc", "2026-07-01T15:00:00.000Z");
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

async function run(f: FormData): Promise<{ error?: string } | { redirectTo: string }> {
  try {
    return (await createBooking(undefined, f)) ?? {};
  } catch (err) {
    if (err instanceof RedirectError) return { redirectTo: err.url };
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: "u1" };
  state.student = { id: "s1", email: "a@b.com", disabledAt: null };
  state.pkg = {
    id: "pkg1",
    teacherId: "t1",
    templateId: "tmpl1",
    teacher: { id: "t1", name: "Prof. Mira" },
    template: { name: "5 clases de 50 min", singleClass: false },
  };
  state.outcome = { code: "ok", bookingId: "bk1" };
});

describe("createBooking", () => {
  it("rejects invalid input", async () => {
    expect(await run(fd({ packageId: "nope" }))).toHaveProperty("error");
    expect(bookPackageSlot).not.toHaveBeenCalled();
  });

  it("blocks a disabled account", async () => {
    state.student = { id: "s1", email: "a@b.com", disabledAt: new Date() };
    expect(await run(fd())).toHaveProperty("error");
    expect(bookPackageSlot).not.toHaveBeenCalled();
  });

  it("errors when the package is unavailable", async () => {
    state.pkg = null;
    expect(await run(fd())).toHaveProperty("error");
  });

  it.each([["package-exhausted"], ["package-expired"], ["slot-taken"], ["something-else"]])(
    "maps the %s outcome to an error",
    async (code) => {
      state.outcome = { code };
      const res = await run(fd());
      expect(res).toHaveProperty("error");
    },
  );

  it("redirects to the confirmation page on success", async () => {
    const res = await run(fd());
    expect(res).toEqual({
      redirectTo: "/my-classes/book/confirmation?bookingId=bk1",
    });
  });

  it("tracks booking_created with teacher, class and schedule metadata", async () => {
    await run(fd());
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "booking_created",
        distinctId: "s1",
        properties: expect.objectContaining({
          teacherId: "t1",
          teacherName: "Prof. Mira",
          bookingId: "bk1",
          packageId: "pkg1",
          classId: "tmpl1",
          className: "5 clases de 50 min",
          classType: "package",
          scheduledAt: "2026-07-01T15:00:00.000Z",
          via: "via_link",
        }),
      }),
    );
  });
});
