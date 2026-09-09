import { beforeEach, describe, expect, it, vi } from "vitest";

// checkBookingSlugAvailability — the advisory "available / taken" check behind
// the slug editor's live hint. Pins: offline validation short-circuits before
// any DB read, the teacher's own slug reads as "current", a row owned by
// someone else is "taken", and a free (or self-owned) slug is "available".

const findUnique = vi.fn(async (_a?: unknown) => null as { id: string } | null);
// freeSuggestions batches the candidate lookup through findMany; default to
// "all free" so the taken case yields suggestions.
const findMany = vi.fn(async (_a?: unknown) => [] as Array<{ bookingSlug: string }>);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: {
      findUnique: (a: unknown) => findUnique(a),
      findMany: (a: unknown) => findMany(a),
    },
  },
}));

const { checkBookingSlugAvailability } = await import("@/lib/booking-slug");

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe("checkBookingSlugAvailability", () => {
  it("returns invalid for a too-short slug without hitting the DB", async () => {
    const r = await checkBookingSlugAvailability("t1", "mira-current", "a!");
    expect(r).toEqual({ status: "invalid", reason: "too-short" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns invalid for a reserved slug without hitting the DB", async () => {
    const r = await checkBookingSlugAvailability("t1", "mira-current", "Admin");
    expect(r).toEqual({ status: "invalid", reason: "reserved" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns current when the normalized slug is the teacher's own", async () => {
    const r = await checkBookingSlugAvailability("t1", "mira-current", "Mira Current");
    expect(r).toEqual({ status: "current", slug: "mira-current" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns available when no row holds the slug", async () => {
    findUnique.mockResolvedValue(null);
    const r = await checkBookingSlugAvailability("t1", "mira-current", "brand-new");
    expect(r).toEqual({ status: "available", slug: "brand-new" });
  });

  it("returns taken with free suggestions when another teacher holds the slug", async () => {
    findUnique.mockResolvedValue({ id: "t2" });
    const r = await checkBookingSlugAvailability("t1", "mira-current", "popular");
    expect(r.status).toBe("taken");
    if (r.status !== "taken") throw new Error("expected taken");
    expect(r.slug).toBe("popular");
    // All candidates are free (findMany → []), so we get the friendly variants.
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.suggestions).toContain("popular-mx");
    expect(r.suggestions.every((s) => s !== "popular")).toBe(true);
  });

  it("drops suggestion candidates that are themselves taken", async () => {
    findUnique.mockResolvedValue({ id: "t2" });
    // popular-mx and popular-clases are taken; the next free variant wins.
    findMany.mockResolvedValue([{ bookingSlug: "popular-mx" }, { bookingSlug: "popular-clases" }]);
    const r = await checkBookingSlugAvailability("t1", "mira-current", "popular");
    if (r.status !== "taken") throw new Error("expected taken");
    expect(r.suggestions).not.toContain("popular-mx");
    expect(r.suggestions).not.toContain("popular-clases");
    expect(r.suggestions).toContain("popular1");
  });

  it("treats a row owned by the same teacher as available (defensive)", async () => {
    findUnique.mockResolvedValue({ id: "t1" });
    const r = await checkBookingSlugAvailability("t1", "mira-current", "mine-again");
    expect(r).toEqual({ status: "available", slug: "mine-again" });
  });
});
