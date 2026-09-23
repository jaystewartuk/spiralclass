import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// captionAccessFor — the check both live-caption routes run per request. The
// order matters as much as the checks: the flag before any database read, the
// party-scoped booking lookup before the plan, and the plan of the TEACHER
// whoever is asking.

const state = {
  enabled: true,
  session: { bookingId: "b1", teacherIdentity: "t1" } as Record<string, unknown> | null,
  gateOk: true,
};

vi.mock("@/lib/captions/config", () => ({ liveCaptionsEnabled: () => state.enabled }));
const resolveCaptionSession = vi.fn(async (..._a: unknown[]) => state.session);
vi.mock("@/lib/captions/class-access", () => ({
  resolveCaptionSession: (...a: unknown[]) => resolveCaptionSession(...a),
}));
const studentIdentityIds = vi.fn(async () => ["s1", "s1-sibling"]);
vi.mock("@/lib/students/identity", () => ({ studentIdentityIds: () => studentIdentityIds() }));
const gateProFeature = vi.fn(async (..._a: unknown[]) =>
  state.gateOk ? { ok: true } : { ok: false, limit: "lesson_notes" },
);
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: (...a: unknown[]) => gateProFeature(...a),
}));

const { captionAccessFor } = await import("@/lib/captions/access");

const TEACHER = { role: "teacher", teacher: { id: "t1" } } as never;
const STUDENT = { role: "student", student: { id: "s1", email: "a@b.c" } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  state.session = { bookingId: "b1", teacherIdentity: "t1" };
  state.gateOk = true;
});

describe("captionAccessFor", () => {
  it("grants the teacher her own class, naming her as the caller", async () => {
    expect(await captionAccessFor(TEACHER, "b1")).toEqual({
      ok: true,
      session: state.session,
      callerId: "t1",
    });
    expect(resolveCaptionSession).toHaveBeenCalledWith("b1", { role: "teacher", teacherId: "t1" });
  });

  it("resolves a student across every row her sign-in owns", async () => {
    expect(await captionAccessFor(STUDENT, "b1")).toMatchObject({ ok: true, callerId: "s1" });
    expect(resolveCaptionSession).toHaveBeenCalledWith("b1", {
      role: "student",
      studentIds: ["s1", "s1-sibling"],
    });
  });

  it("refuses with the flag off before reading anything", async () => {
    state.enabled = false;
    expect(await captionAccessFor(TEACHER, "b1")).toEqual({ ok: false, reason: "disabled" });
    expect(resolveCaptionSession).not.toHaveBeenCalled();
  });

  it("refuses a class the caller is not a party to as not-found", async () => {
    state.session = null;
    expect(await captionAccessFor(STUDENT, "b1")).toEqual({ ok: false, reason: "not-found" });
    expect(gateProFeature).not.toHaveBeenCalled();
  });

  it("checks the teacher's plan even when the student asks", async () => {
    state.gateOk = false;
    expect(await captionAccessFor(STUDENT, "b1")).toEqual({ ok: false, reason: "not-entitled" });
    expect(gateProFeature).toHaveBeenCalledWith("t1", "lesson_notes");
  });
});
