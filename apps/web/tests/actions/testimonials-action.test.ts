import { beforeEach, describe, expect, it, vi } from "vitest";
import { TESTIMONIAL_BODY_MAX } from "@/lib/testimonials/limits";

// Teacher-authored testimonials CRUD (public-page social proof, D-24). Every
// mutation must: validate, gate on requireOnboardedTeacher, scope the write by
// teacherId (so a teacher can't touch another's row — count==0 → not-found),
// and revalidate both the editor and the public booking page.

const state = {
  updateCount: 1,
  deleteCount: 1,
  lastSortOrder: 4 as number | null,
  // The teacher's own list, in display order, for the reorder action.
  list: [] as { id: string }[],
  // The `locale` cookie the request carries. Left unset, getPreferredLocale
  // falls through to DEFAULT_LOCALE ("en").
  locale: undefined as string | undefined,
};

const findFirst = vi.fn(async () =>
  state.lastSortOrder === null ? null : { sortOrder: state.lastSortOrder },
);
const findMany = vi.fn(async (_a: { where: Record<string, unknown> }) => state.list);
const create = vi.fn(async (_a: { data: Record<string, unknown> }) => ({ id: "ts1" }));
const updateMany = vi.fn(
  async (_a: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
    count: state.updateCount,
  }),
);
const deleteMany = vi.fn(async (_a: { where: Record<string, unknown> }) => ({
  count: state.deleteCount,
}));
const transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: transaction,
    testimonial: { findFirst, findMany, create, updateMany, deleteMany },
  },
}));

// A real request scope, so the actions resolve their copy through the real
// catalog rather than falling into getPreferredLocale's outside-a-request
// catch. That is what lets the French assertion below mean anything.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "locale" && state.locale ? { value: state.locale } : undefined,
  }),
  headers: async () => ({ get: () => null }),
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1", bookingSlug: "mira" })),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const {
  addTestimonial,
  updateTestimonial,
  setTestimonialPublished,
  moveTestimonial,
  deleteTestimonial,
} = await import("@/app/actions/testimonials");

const ID = "11111111-1111-1111-1111-111111111111";

// The add/update schemas read authorNote via formData.get(); a real form always
// renders that input (sends ""), and the schema's optional() rejects a literal
// null — so default it to "" unless a test overrides it.
function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  if (!("authorNote" in fields) && ("authorName" in fields || "body" in fields)) {
    f.set("authorNote", "");
  }
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updateCount = 1;
  state.deleteCount = 1;
  state.lastSortOrder = 4;
  state.list = [];
  state.locale = undefined;
});

describe("addTestimonial", () => {
  it("rejects an empty body without writing", async () => {
    const res = await addTestimonial(undefined, form({ authorName: "Sofía", body: "" }));
    expect(res).toHaveProperty("error");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an over-long body", async () => {
    expect(
      await addTestimonial(
        undefined,
        form({ authorName: "Sofía", body: "x".repeat(TESTIMONIAL_BODY_MAX + 1) }),
      ),
    ).toHaveProperty("error");
    expect(create).not.toHaveBeenCalled();
  });

  it("appends after the current max sortOrder and revalidates both pages", async () => {
    const res = await addTestimonial(
      undefined,
      form({ authorName: "Sofía", authorNote: "B1", body: "¡Excelente!" }),
    );
    expect(res).toEqual({ ok: true });
    expect(create.mock.calls[0][0].data).toMatchObject({
      teacherId: "t1",
      authorName: "Sofía",
      authorNote: "B1",
      body: "¡Excelente!",
      sortOrder: 5,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/testimonials");
    expect(revalidatePath).toHaveBeenCalledWith("/b/mira");
  });

  it("starts sortOrder at 1 when the teacher has none", async () => {
    state.lastSortOrder = null;
    await addTestimonial(undefined, form({ authorName: "Sofía", body: "Hola" }));
    expect(create.mock.calls[0][0].data.sortOrder).toBe(1);
  });
});

describe("updateTestimonial", () => {
  it("scopes by teacherId and source, and reports not-found on count 0", async () => {
    state.updateCount = 0;
    const res = await updateTestimonial(
      undefined,
      form({ id: ID, authorName: "Sofía", body: "Nuevo" }),
    );
    expect(res).toHaveProperty("error");
    // The source filter is why a count of 0 is also the answer for a verified
    // row she owns: the edit finds nothing to write to, and she gets the same
    // not-found she would for someone else's testimonial.
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: ID,
      teacherId: "t1",
      source: "teacher_curated",
    });
  });

  it("updates an owned testimonial", async () => {
    const res = await updateTestimonial(
      undefined,
      form({ id: ID, authorName: "Sofía", body: "Nuevo" }),
    );
    expect(res).toEqual({ ok: true });
  });
});

describe("setTestimonialPublished", () => {
  it("coerces the published flag and scopes by teacherId", async () => {
    const res = await setTestimonialPublished(undefined, form({ id: ID, published: "true" }));
    expect(res).toEqual({ ok: true });
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: ID, teacherId: "t1" },
      data: { published: true },
    });
  });
});

describe("deleteTestimonial", () => {
  it("rejects a non-uuid id", async () => {
    expect(await deleteTestimonial(undefined, form({ id: "nope" }))).toHaveProperty("error");
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("deletes scoped by teacherId and reports not-found on count 0", async () => {
    state.deleteCount = 0;
    const res = await deleteTestimonial(undefined, form({ id: ID }));
    expect(res).toHaveProperty("error");
    expect(deleteMany.mock.calls[0][0].where).toEqual({ id: ID, teacherId: "t1" });
  });
});

describe("moveTestimonial", () => {
  const OTHER = "22222222-2222-2222-2222-222222222222";

  it("rejects a direction that is not up or down", async () => {
    expect(
      await moveTestimonial(undefined, form({ id: ID, direction: "sideways" })),
    ).toHaveProperty("error");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid id", async () => {
    expect(await moveTestimonial(undefined, form({ id: "nope", direction: "up" }))).toHaveProperty(
      "error",
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reorders an owned testimonial and revalidates both pages", async () => {
    state.list = [{ id: OTHER }, { id: ID }];
    const res = await moveTestimonial(undefined, form({ id: ID, direction: "up" }));

    expect(res).toEqual({ ok: true });
    expect(updateMany.mock.calls.map((c) => [c[0].where.id, c[0].data.sortOrder])).toEqual([
      [ID, 0],
      [OTHER, 1],
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/testimonials");
    expect(revalidatePath).toHaveBeenCalledWith("/b/mira");
  });

  // The arrow that could send this is disabled at the ends, so a request that
  // arrives anyway (a stale page, a double tap) is a no-op — not an error to
  // put in front of her, and nothing to revalidate.
  it("is a quiet no-op at the end of the list", async () => {
    state.list = [{ id: ID }, { id: OTHER }];
    const res = await moveTestimonial(undefined, form({ id: ID, direction: "up" }));

    expect(res).toEqual({ ok: true });
    expect(updateMany).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("cannot renumber a row belonging to another teacher", async () => {
    state.list = [{ id: OTHER }];
    expect(await moveTestimonial(undefined, form({ id: ID, direction: "down" }))).toEqual({
      ok: true,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0][0].where).toEqual({ teacherId: "t1" });
  });
});

// Every message these actions return used to be a `locale === "en" ? en : es`
// ternary, which has no third branch — so a French teacher was told
// "No encontramos ese testimonio." The catalog is the only thing that knows
// every registered locale, and it fails to compile when a key misses one.
describe("error copy follows the request locale", () => {
  it("answers a French teacher in French", async () => {
    state.locale = "fr";
    const res = await deleteTestimonial(undefined, form({ id: "nope" }));
    expect(res?.error).toBe("Des données manquaient. Rechargez la page et réessayez.");
  });

  it("answers a Spanish teacher in Spanish", async () => {
    state.locale = "es-MX";
    state.deleteCount = 0;
    const res = await deleteTestimonial(undefined, form({ id: ID }));
    expect(res?.error).toBe("No encontramos ese testimonio.");
  });

  it("answers in English by default", async () => {
    const res = await addTestimonial(undefined, form({ authorName: "Sofía", body: "" }));
    expect(res?.error).toBe("Add a name and the testimonial text (1200 characters or fewer).");
  });
});
