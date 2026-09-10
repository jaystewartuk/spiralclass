import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// saveBookingSlugAction — the teacher-facing booking-slug editor (the "enlace
// de reservas"), used in onboarding and Settings → Account. Pins: offline
// normalize+validate, the no-op-when-unchanged short circuit, the friendly
// "taken" translation of a P2002 unique-constraint violation, and that a real
// change writes the normalized slug and revalidates both /b pages.

const state = {
  teacher: { id: "t1", bookingSlug: "alicia-moreno-abc123" },
  updateError: null as unknown,
};

const teacherUpdate = vi.fn(async (_a: { data: { bookingSlug: string } }) => {
  if (state.updateError) throw state.updateError;
  return { id: "t1" };
});

vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({
  prisma: { teacher: { update: teacherUpdate } },
}));

vi.mock("@/lib/auth", () => ({
  requireTeacher: vi.fn(async () => state.teacher),
}));

vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: vi.fn(async () => "en"),
}));

const trackServerEvent = vi.fn();
const flushAnalytics = vi.fn(async () => {});
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent, flushAnalytics }));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

// The other named exports in profile.ts pull in storage/focus-tags helpers we
// don't need here, but they only run when their own actions are called.
const { saveBookingSlugAction } = await import("@/app/actions/profile");

function form(bookingSlug: string): FormData {
  const f = new FormData();
  f.set("bookingSlug", bookingSlug);
  return f;
}

beforeEach(() => {
  state.teacher = { id: "t1", bookingSlug: "alicia-moreno-abc123" };
  state.updateError = null;
  teacherUpdate.mockClear();
  trackServerEvent.mockClear();
  revalidatePath.mockClear();
});

describe("saveBookingSlugAction", () => {
  it("normalizes input, writes it, and reports the canonical slug", async () => {
    const result = await saveBookingSlugAction(undefined, form("Profe María"));
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { bookingSlug: "profe-maria" },
    });
    expect(result).toEqual({ ok: true, slug: "profe-maria" });
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "teacher_booking_slug_changed" }),
    );
    // Old and new public pages both busted.
    // One revalidation, for the settings page this form is on (D-174). The two
    // /b/<slug> pages are dynamic routes with nothing prerendered to
    // invalidate, and a second call here would cost the form its own result.
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(["/settings/booking-page"]);
  });

  it("rejects too-short slugs without touching the database", async () => {
    const result = await saveBookingSlugAction(undefined, form("a!"));
    expect(result?.error).toBeTruthy();
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("rejects reserved slugs", async () => {
    const result = await saveBookingSlugAction(undefined, form("admin"));
    expect(result?.error).toBeTruthy();
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("no-ops when the normalized slug is unchanged", async () => {
    const result = await saveBookingSlugAction(undefined, form("alicia-moreno-abc123"));
    expect(result).toEqual({ ok: true, slug: "alicia-moreno-abc123" });
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("translates a unique-constraint violation into a friendly taken error", async () => {
    state.updateError = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "test",
    });
    const result = await saveBookingSlugAction(undefined, form("taken-slug"));
    expect(result?.error).toMatch(/taken/i);
    expect(result?.ok).toBeUndefined();
  });
});
