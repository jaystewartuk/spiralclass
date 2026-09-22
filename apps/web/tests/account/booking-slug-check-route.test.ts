import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/account/booking-slug — cookie-authed live availability for the web
// slug editor. Pins: 401 when signed out, and that the current slug used to
// exempt "taken by me" comes from the session (never the query string).

const state = {
  teacher: { id: "t1", bookingSlug: "mira-current" } as { id: string; bookingSlug: string } | null,
  existing: null as { id: string } | null,
};

vi.mock("@/lib/auth", () => ({
  getCurrentTeacher: vi.fn(async () => state.teacher),
}));

const findUnique = vi.fn(async (_a?: unknown) => state.existing);
// Suggestion lookup on the taken path — default "all free".
const findMany = vi.fn(async (_a?: unknown) => [] as Array<{ bookingSlug: string }>);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: {
      findUnique: (a: unknown) => findUnique(a),
      findMany: (a: unknown) => findMany(a),
    },
  },
}));

const { GET } = await import("@/app/api/account/booking-slug/route");

function get(slug: string): Request {
  return new Request(
    `https://test.local/api/account/booking-slug?slug=${encodeURIComponent(slug)}`,
  );
}

beforeEach(() => {
  state.teacher = { id: "t1", bookingSlug: "mira-current" };
  state.existing = null;
  findUnique.mockClear();
});

describe("GET /api/account/booking-slug", () => {
  it("401s when signed out", async () => {
    state.teacher = null;
    const res = await GET(get("anything"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "unauthorized" });
  });

  it("reports availability for a free slug", async () => {
    const res = await GET(get("brand-new"));
    expect(await res.json()).toEqual({ status: "available", slug: "brand-new" });
  });

  it("reports taken with suggestions when another teacher holds it", async () => {
    state.existing = { id: "t2" };
    const res = await GET(get("popular"));
    const body = await res.json();
    expect(body.status).toBe("taken");
    expect(body.slug).toBe("popular");
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.length).toBeGreaterThan(0);
  });

  it("reports current for the teacher's own slug, ignoring the DB", async () => {
    const res = await GET(get("mira-current"));
    expect(await res.json()).toEqual({ status: "current", slug: "mira-current" });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
