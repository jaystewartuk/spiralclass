import { beforeEach, describe, expect, it, vi } from "vitest";

// Saved Facebook-groups CRUD (STUDENT_ACQUISITION.md). Every mutation must:
// validate (name required, url must be a real URL when present), gate on
// requireOnboardedTeacher, scope the write by teacherId (count==0 → not-found),
// and revalidate the editor page.

const state = { updateCount: 1, deleteCount: 1, lastSortOrder: 4 as number | null };

const findFirst = vi.fn(async () =>
  state.lastSortOrder === null ? null : { sortOrder: state.lastSortOrder },
);
const create = vi.fn(async (_a: { data: Record<string, unknown> }) => ({ id: "g1" }));
const updateMany = vi.fn(
  async (_a: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
    count: state.updateCount,
  }),
);
const deleteMany = vi.fn(async (_a: { where: Record<string, unknown> }) => ({
  count: state.deleteCount,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { teacherShareGroup: { findFirst, create, updateMany, deleteMany } },
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1", bookingSlug: "mira" })),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { addShareGroup, updateShareGroup, deleteShareGroup } =
  await import("@/app/actions/share-groups");

const ID = "11111111-1111-1111-1111-111111111111";

// A real form always renders the url input (sends ""); the schema's optional()
// rejects a literal null — so default url to "" unless a test overrides it.
function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  if (!("url" in fields) && "name" in fields) f.set("url", "");
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updateCount = 1;
  state.deleteCount = 1;
  state.lastSortOrder = 4;
});

describe("addShareGroup", () => {
  it("rejects an empty name without writing", async () => {
    const res = await addShareGroup(undefined, form({ name: "" }));
    expect(res).toHaveProperty("error");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a non-URL link", async () => {
    const res = await addShareGroup(undefined, form({ name: "Mamás", url: "not a url" }));
    expect(res).toHaveProperty("error");
    expect(create).not.toHaveBeenCalled();
  });

  it("appends after the current max sortOrder and revalidates the editor", async () => {
    const res = await addShareGroup(
      undefined,
      form({ name: "Mamás de Polanco", url: "https://www.facebook.com/groups/123" }),
    );
    expect(res).toEqual({ ok: true });
    expect(create.mock.calls[0][0].data).toMatchObject({
      teacherId: "t1",
      name: "Mamás de Polanco",
      url: "https://www.facebook.com/groups/123",
      sortOrder: 5,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/get-students/communities");
  });

  it("stores null url when the field is blank, and starts sortOrder at 1", async () => {
    state.lastSortOrder = null;
    await addShareGroup(undefined, form({ name: "Solo nombre" }));
    expect(create.mock.calls[0][0].data).toMatchObject({ url: null, sortOrder: 1 });
  });
});

describe("updateShareGroup", () => {
  it("scopes by teacherId and reports not-found on count 0", async () => {
    state.updateCount = 0;
    const res = await updateShareGroup(undefined, form({ id: ID, name: "Nuevo" }));
    expect(res).toHaveProperty("error");
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: ID, teacherId: "t1" });
  });

  it("updates an owned group", async () => {
    const res = await updateShareGroup(undefined, form({ id: ID, name: "Nuevo" }));
    expect(res).toEqual({ ok: true });
  });
});

describe("deleteShareGroup", () => {
  it("rejects a non-uuid id", async () => {
    expect(await deleteShareGroup(undefined, form({ id: "nope" }))).toHaveProperty("error");
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("deletes scoped by teacherId and reports not-found on count 0", async () => {
    state.deleteCount = 0;
    const res = await deleteShareGroup(undefined, form({ id: ID }));
    expect(res).toHaveProperty("error");
    expect(deleteMany.mock.calls[0][0].where).toEqual({ id: ID, teacherId: "t1" });
  });
});
