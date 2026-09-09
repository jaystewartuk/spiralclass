import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The community store. Two rules carry real weight: a newly added community
// inherits its PLATFORM's conservative promotion default rather than "open",
// and retiring one archives rather than deletes so its historical acquisition
// results stay attributable.

const findMany = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();
const count = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherShareGroup: { findMany, findFirst, create, updateMany, deleteMany, count },
  },
}));

const {
  addCommunity,
  archiveCommunity,
  communityInputSchema,
  countCommunities,
  deleteCommunity,
  listCommunities,
  restoreCommunity,
  toCommunityView,
  updateCommunity,
} = await import("@/lib/marketing/communities");

function row(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "Oaxaca Expats",
    url: null,
    platform: "facebook_group",
    promoPolicy: "limited",
    audienceNote: null,
    promoWeekdays: [],
    promoEveryDays: null,
    promoLinksAllowed: null,
    promoNotes: null,
    memeBrief: null,
    archivedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([row()]);
  findFirst.mockResolvedValue({ sortOrder: 3 });
  create.mockImplementation(async (a: { data: Record<string, unknown> }) => row(a.data));
  updateMany.mockResolvedValue({ count: 1 });
  deleteMany.mockResolvedValue({ count: 1 });
  count.mockResolvedValue(2);
});

describe("toCommunityView", () => {
  it("degrades an unrecognised platform or policy to the safe value", () => {
    // A value written by a newer deploy must never be read as permission.
    const view = toCommunityView(
      row({ platform: "myspace", promoPolicy: "definitely_fine" }) as never,
    );
    expect(view.platform).toBe("other");
    expect(view.promoPolicy).toBe("unknown");
  });

  it("exposes archived as a boolean the UI can branch on", () => {
    expect(toCommunityView(row({ archivedAt: new Date() }) as never).archived).toBe(true);
    expect(toCommunityView(row() as never).archived).toBe(false);
  });
});

describe("listCommunities", () => {
  it("hides archived communities by default", async () => {
    await listCommunities("t1");
    expect(findMany.mock.calls[0][0].where).toMatchObject({ teacherId: "t1", archivedAt: null });
  });

  it("includes them when the editor asks for them", async () => {
    await listCommunities("t1", { includeArchived: true });
    expect(findMany.mock.calls[0][0].where).toEqual({ teacherId: "t1" });
  });

  it("counts only live ones for the nudge-eligibility gate", async () => {
    await countCommunities("t1");
    expect(count.mock.calls[0][0]).toEqual({ where: { teacherId: "t1", archivedAt: null } });
  });
});

describe("addCommunity", () => {
  it("inherits the PLATFORM's conservative default when she doesn't state a policy", async () => {
    await addCommunity("t1", { name: "r/Spanish", platform: "reddit" });
    expect(create.mock.calls[0][0].data.promoPolicy).toBe("prohibited");

    await addCommunity("t1", { name: "A group", platform: "facebook_group" });
    expect(create.mock.calls[1][0].data.promoPolicy).toBe("limited");
  });

  it("respects a policy she states explicitly", async () => {
    await addCommunity("t1", { name: "X", platform: "reddit", promoPolicy: "open" });
    expect(create.mock.calls[0][0].data.promoPolicy).toBe("open");
  });

  it("defaults an unspecified platform to a Facebook group — every legacy row is one", async () => {
    await addCommunity("t1", { name: "X" });
    expect(create.mock.calls[0][0].data.platform).toBe("facebook_group");
  });

  it("sorts a new community after the existing ones", async () => {
    await addCommunity("t1", { name: "X" });
    expect(create.mock.calls[0][0].data.sortOrder).toBe(4);
    findFirst.mockResolvedValue(null);
    await addCommunity("t1", { name: "Y" });
    expect(create.mock.calls[1][0].data.sortOrder).toBe(1);
  });
});

describe("mutations are teacher-scoped", () => {
  it("scopes update, archive, restore and delete by teacher id", async () => {
    await updateCommunity("t1", "c1", { name: "New name" });
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: "c1", teacherId: "t1" });

    await archiveCommunity("t1", "c1");
    expect(updateMany.mock.calls[1][0].where).toEqual({
      id: "c1",
      teacherId: "t1",
      archivedAt: null,
    });
    expect(updateMany.mock.calls[1][0].data.archivedAt).toBeInstanceOf(Date);

    await restoreCommunity("t1", "c1");
    expect(updateMany.mock.calls[2][0].data).toEqual({ archivedAt: null });

    await deleteCommunity("t1", "c1");
    expect(deleteMany.mock.calls[0][0]).toEqual({ where: { id: "c1", teacherId: "t1" } });
  });

  it("leaves the platform and policy untouched when the form omits them", async () => {
    await updateCommunity("t1", "c1", { name: "New name" });
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty("platform");
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty("promoPolicy");
  });

  it("reports false when nothing matched", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    deleteMany.mockResolvedValue({ count: 0 });
    expect(await updateCommunity("t1", "x", { name: "y" })).toBe(false);
    expect(await archiveCommunity("t1", "x")).toBe(false);
    expect(await restoreCommunity("t1", "x")).toBe(false);
    expect(await deleteCommunity("t1", "x")).toBe(false);
  });
});

describe("communityInputSchema", () => {
  it("requires a name and rejects a non-URL link", () => {
    expect(communityInputSchema.safeParse({ name: "" }).success).toBe(false);
    expect(communityInputSchema.safeParse({ name: "X", url: "nope" }).success).toBe(false);
    expect(communityInputSchema.safeParse({ name: "X", url: "" }).success).toBe(true);
  });

  it("treats an empty audience note as absent", () => {
    expect(
      communityInputSchema.parse({ name: "X", audienceNote: "" }).audienceNote,
    ).toBeUndefined();
  });

  it("rejects a platform or policy that isn't in the registry", () => {
    expect(communityInputSchema.safeParse({ name: "X", platform: "myspace" }).success).toBe(false);
    expect(communityInputSchema.safeParse({ name: "X", promoPolicy: "sure" }).success).toBe(false);
  });
});

describe("promotion rules on a community", () => {
  it("reads a bare legacy row as 'no rules', which is today's behaviour", async () => {
    // Every community that exists on the day this ships has empty days, no
    // frequency and no link override — and that combination must mean "any
    // day, no limit, follow the platform", never "blocked".
    const view = toCommunityView(row());
    expect(view.rules).toEqual({
      weekdays: [],
      everyDays: null,
      linksAllowed: null,
      notes: null,
    });
    expect(view.memeBrief).toBeNull();
  });

  it("normalises whatever is on the row rather than trusting it", async () => {
    const view = toCommunityView(
      row({ promoWeekdays: [5, 1, 5, 99], promoEveryDays: 1000, promoLinksAllowed: false }),
    );
    expect(view.rules.weekdays).toEqual([1, 5]);
    expect(view.rules.everyDays).toBe(90);
    expect(view.rules.linksAllowed).toBe(false);
  });

  it("writes the rules a form supplied, normalised", async () => {
    await addCommunity("t1", {
      name: "Oaxaca Expats",
      promoWeekdays: [5, 5, 1],
      promoEveryDays: 14,
      promoLinksAllowed: "no",
      promoNotes: "Friday thread only",
      memeBrief: "Retired expats.",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      promoWeekdays: [1, 5],
      promoEveryDays: 14,
      promoLinksAllowed: false,
      promoNotes: "Friday thread only",
      memeBrief: "Retired expats.",
    });
  });

  it("leaves stored rules alone when a form did not render them", async () => {
    // A narrower client — the mobile share-groups route, an older build — must
    // never blank a rule it does not know about.
    await updateCommunity("t1", "c1", { name: "Oaxaca Expats" });
    const data = updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("promoWeekdays");
    expect(data).not.toHaveProperty("promoEveryDays");
    expect(data).not.toHaveProperty("promoLinksAllowed");
    expect(data).not.toHaveProperty("promoNotes");
    expect(data).not.toHaveProperty("memeBrief");
  });

  it("lets her clear every rule she had set", async () => {
    await updateCommunity("t1", "c1", {
      name: "Oaxaca Expats",
      promoWeekdays: [],
      promoEveryDays: null,
      promoLinksAllowed: "default",
      promoNotes: "",
      memeBrief: "",
    });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      promoWeekdays: [],
      promoEveryDays: null,
      promoLinksAllowed: null,
      promoNotes: null,
      memeBrief: null,
    });
  });

  it("rejects a note or brief past its bound rather than silently truncating", () => {
    expect(communityInputSchema.safeParse({ name: "x", promoNotes: "n".repeat(401) }).success).toBe(
      false,
    );
    expect(communityInputSchema.safeParse({ name: "x", memeBrief: "m".repeat(701) }).success).toBe(
      false,
    );
  });
});

describe("getCommunity", () => {
  it("scopes the read to the teacher and returns null for anyone else's id", async () => {
    const { getCommunity } = await import("@/lib/marketing/communities");
    findFirst.mockResolvedValue(null);
    expect(await getCommunity("t1", "someone-elses")).toBeNull();
    expect(findFirst.mock.calls.at(-1)?.[0].where).toEqual({
      id: "someone-elses",
      teacherId: "t1",
    });
  });

  it("returns the normalised view for her own", async () => {
    const { getCommunity } = await import("@/lib/marketing/communities");
    findFirst.mockResolvedValue(row({ promoWeekdays: [5] }));
    const view = await getCommunity("t1", "c1");
    expect(view?.rules.weekdays).toEqual([5]);
  });
});
