import { describe, it, expect, vi, beforeEach } from "vitest";

// The two web endpoints behind the in-call "My library" tab, moved out of a
// route tree that has since been deleted.
//
// What this pins is the part a move can silently break:
//  1. Both refuse an unauthenticated caller with a 401 JSON body rather than
//     the 307-to-/sign-in a `redirect()`-based guard would emit. The caller is
//     a `fetch()` from a client component, which FOLLOWS a redirect and then
//     fails on `res.json()` of an HTML page — an auth failure would surface as
//     a generic error state instead of a 401 anyone can read.
//  2. Every query the browser sends is threaded to the shared query engine
//     unchanged, and the teacher's own id is what scopes it. The filter
//     semantics live in parseLibraryListParams/listLibraryMaterialsCursor and
//     did not move; what could move is the wiring between them.
//  3. `filters` returns exactly the two fields the picker reads. It is not the
//     old bootstrap: if it grows a materials query, a template list or an
//     entitlements load again, every call-sheet open pays for fields nothing
//     renders.

const getCurrentTeacher = vi.fn();
vi.mock("@/lib/auth", () => ({ getCurrentTeacher: () => getCurrentTeacher() }));

const getTeacherLevels = vi.fn(async (_teacherId: string) => [
  { id: "lvl1", code: "A1", label: "Beginner", position: 0 },
]);
vi.mock("@/lib/levels", () => ({ getTeacherLevels: (id: string) => getTeacherLevels(id) }));

const getTeacherFocusGroups = vi.fn(
  async (_teacherId: string, _targetLanguage: string | null, _locale: string) => [
    { id: "cat1", label: "Grammar", tags: [{ id: "tag1", label: "Past tense" }] },
  ],
);
vi.mock("@/lib/focus-tags", () => ({
  getTeacherFocusGroups: (t: string, lang: string | null, locale: string) =>
    getTeacherFocusGroups(t, lang, locale),
}));

type Filters = { teacherId: string } & Record<string, unknown>;
type PageOpts = { sort: string; take: number; cursor: string | null };
const listLibraryMaterialsCursor = vi.fn(async (_filters: Filters, _opts: PageOpts) => ({
  rows: [{ id: "m1", storagePath: null, linkUrl: null }],
  nextCursor: "m1" as string | null,
}));
vi.mock("@/lib/library/library-queries", () => ({
  listLibraryMaterialsCursor: (filters: Filters, opts: PageOpts) =>
    listLibraryMaterialsCursor(filters, opts),
}));

vi.mock("@/lib/storage/provider", () => ({ getStorageProvider: () => ({}) }));
vi.mock("@/lib/storage/signed-urls", () => ({ pickMaterialsUrl: () => "https://example/x" }));
vi.mock("@/lib/materials/library-admin", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/materials/library-admin")>();
  return { ...actual, mapLibraryRowToAdmin: async (r: { id: string }) => ({ id: r.id }) };
});

const { GET: getFilters } = await import("@/app/api/teacher/library/filters/route");
const { GET: getMaterials } = await import("@/app/api/teacher/library/materials/route");

const TEACHER = { id: "t1", locale: "en", targetLanguage: "es" };

function materialsReq(query = ""): Request {
  return new Request(`http://test.local/api/teacher/library/materials${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentTeacher.mockResolvedValue(TEACHER);
});

describe("GET /api/teacher/library/filters", () => {
  it("401s a caller with no session instead of redirecting it", async () => {
    getCurrentTeacher.mockResolvedValue(null);
    const res = await getFilters();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("returns the level ladder and focus groups, scoped to the acting teacher", async () => {
    const res = await getFilters();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      levels: [{ id: "lvl1", label: "Beginner" }],
      focusGroups: [{ id: "cat1", label: "Grammar", tags: [{ id: "tag1", label: "Past tense" }] }],
    });
    expect(getTeacherLevels).toHaveBeenCalledWith("t1");
    expect(getTeacherFocusGroups).toHaveBeenCalledWith("t1", "es", "en");
  });

  it("carries none of the old bootstrap's unused payload", async () => {
    // The route this replaced also built `materials`, `nextCursor`,
    // `templates`, `aiEnabled`, `isPro` and `podcastEnabled`. The picker reads
    // none of them, and each cost a query on every call-sheet open.
    const body = (await (await getFilters()).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["focusGroups", "levels"]);
    expect(listLibraryMaterialsCursor).not.toHaveBeenCalled();
  });

  it("falls back to the default locale when hers is not a known app locale", async () => {
    getCurrentTeacher.mockResolvedValue({ ...TEACHER, locale: "kl-GL" });
    await getFilters();
    expect(getTeacherFocusGroups).toHaveBeenCalledWith("t1", "es", "en");
  });
});

describe("GET /api/teacher/library/materials", () => {
  it("401s a caller with no session instead of redirecting it", async () => {
    getCurrentTeacher.mockResolvedValue(null);
    const res = await getMaterials(materialsReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("returns one keyset page in the shared wire shape", async () => {
    const res = await getMaterials(materialsReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: "m1" }], nextCursor: "m1" });
  });

  it("threads the browser's filters, sort, cursor and limit through unchanged", async () => {
    await getMaterials(
      materialsReq(
        "?category=cat1&level=lvl1&type=file&visibility=exact&q=verbs&sort=oldest&limit=12&cursor=m9",
      ),
    );
    expect(listLibraryMaterialsCursor).toHaveBeenCalledWith(
      {
        teacherId: "t1",
        archived: false,
        category: "cat1",
        level: "lvl1",
        type: "file",
        visibility: "exact",
        q: "verbs",
      },
      { sort: "oldest", take: 12, cursor: "m9" },
    );
  });

  it("scopes on the SESSION's teacher, never a teacherId from the query string", async () => {
    await getMaterials(materialsReq("?teacherId=someone-else"));
    const [filters] = listLibraryMaterialsCursor.mock.calls[0];
    expect(filters.teacherId).toBe("t1");
  });
});
