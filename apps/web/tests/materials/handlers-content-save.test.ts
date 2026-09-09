import { beforeEach, describe, expect, it, vi } from "vitest";

// The "write" content-authoring business logic behind the unified
// MaterialForm (docs/features/library-materials.md): saving/generating a
// booking's class content, and saving/generating a reusable library item.
// Covers the Pro gate, empty-body validation, create-vs-update-in-place
// dispatch, revision snapshotting, the AI generate seed + monthly cap, and
// the AI-not-configured surface. The thin action-layer wrappers in
// app/actions/library.ts that parse FormData and dispatch into these by
// bookingId presence are covered separately (parsing/dispatch only) in
// tests/actions/library-content-action.test.ts.

// saveClassContentForBooking now calls the homework auto-draft check
// (lib/homework/auto-draft.ts), which is a server module (`import
// "server-only"`); neutralize the guard, same as homework-wire.test.ts.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn() }));
// Pulled in statically by lib/materials/handlers.ts for the file/link
// attachment path (not exercised here) — stubbed so the module graph doesn't
// reach the real Inngest client, which needs env vars this test doesn't set.
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueMaterialsSend: vi.fn(async () => "notif-id"),
}));
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: vi.fn(async () => {}),
}));

const state = {
  pro: true,
  generationsThisMonth: 0,
  generate: { ok: true, body: "# Generated" } as
    { ok: true; body: string } | { ok: false; reason: "not-configured" | "empty" | "error" },
  refine: { ok: true, body: "# Refined" } as
    { ok: true; body: string } | { ok: false; reason: "not-configured" | "empty" | "error" },
};
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(async () =>
    state.pro ? { ok: true } : { ok: false, limit: "class_content" },
  ),
  upgradeNudge: vi.fn(() => "UPGRADE"),
}));

const generateMaterial = vi.fn(async () => state.generate);
const refineMaterial = vi.fn(async () => state.refine);
vi.mock("@/lib/ai/anthropic", () => ({ generateMaterial, refineMaterial }));

// The booking-scoped "content" material — a LibraryMaterial row with
// bookingId set, sendTiming null, body set (D-69). Tests mutate
// `contentStored` to model the row that "exists" before a given save.
let contentStored: { id: string; body: string; contentSource: string } | null = null;
let libraryMaterialStored: { id: string; body: string; contentSource: string } | null = null;
const materialFindFirst = vi.fn(async () => contentStored);
const materialCreate = vi.fn(async (_args: any) => ({ id: "m1" }) as any);
const materialUpdate = vi.fn(async (_args: any) => ({ id: "m1" }) as any);
// Lesson continuity: rows resolveContinuationMaterials/listContinuationCandidatesForBooking
// read via libraryMaterial.findMany. Tests set this per-case; default empty.
type ContinuationClass = { id: string; scheduledStart: Date };
let continuationRows: {
  id: string;
  label: string | null;
  body: string;
  // Null for a reusable library item; set for a class's own content.
  bookingId?: string | null;
  booking?: ContinuationClass | null;
  // The two routes a REUSABLE item takes into one of this student's classes.
  bookingAttachments?: { booking: ContinuationClass }[];
  classUses?: { booking: ContinuationClass }[];
}[] = [];
const materialFindMany = vi.fn(async (_args?: any) => continuationRows);
const genCreate = vi.fn(async () => ({}));
const revisionCreate = vi.fn(async () => ({}));
const revisionFindMany = vi.fn(async () => [] as { id: string }[]);
const revisionDeleteMany = vi.fn(async () => ({ count: 0 }));
const templateFindFirst = vi.fn(async () => null as { body: string } | null);
const levelFindFirst = vi.fn(async () => ({ id: "lvl1", label: "A2" }) as any);
// The language the teacher teaches — read on every generate path so the AI
// prompt can name the subject instead of inferring one from the output language.
let teacherRow: { targetLanguage: string | null; materialVocabulary?: string | null } = {
  targetLanguage: "es",
};
const teacherFindUnique = vi.fn(async () => teacherRow);
// D-80: the booking-scoped generator reads the class's vocabulary override and
// (when the caller supplies one) writes it back. Model both.
let bookingVocabularyOverride: string | null = null;
const bookingUpdate = vi.fn(async (_args: any) => ({ id: "b1" }) as any);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === "b1" && where.teacherId === "t1"
          ? {
              id: "b1",
              studentId: "s1",
              student: { name: "Renata Ocampo" },
              vocabularyOverride: bookingVocabularyOverride,
            }
          : null,
      ),
      update: (...args: unknown[]) => bookingUpdate(...(args as [any])),
    },
    libraryMaterial: {
      findFirst: (...args: unknown[]) => materialFindFirst(...(args as [])),
      findMany: (...args: unknown[]) => materialFindMany(...(args as [any])),
      create: (...args: unknown[]) => materialCreate(...(args as [any])),
      update: (...args: unknown[]) => materialUpdate(...(args as [any])),
    },
    materialRevision: {
      create: revisionCreate,
      findMany: revisionFindMany,
      deleteMany: revisionDeleteMany,
    },
    classContentTemplate: { findFirst: templateFindFirst },
    classContentGeneration: {
      count: vi.fn(async () => state.generationsThisMonth),
      create: genCreate,
    },
    teacherStudent: {
      findUnique: vi.fn(async () => ({ level: { label: "A2" }, interests: null, goals: null })),
    },
    studentLibraryItem: {
      findMany: vi.fn(async () => [{ material: { label: "Unit 1" } }]),
    },
    level: { findFirst: (...args: unknown[]) => levelFindFirst(...(args as [])) },
    teacher: { findUnique: (...args: unknown[]) => teacherFindUnique(...(args as [])) },
  },
}));

const {
  saveClassContentForBooking,
  generateClassContentForBooking,
  saveLibraryContentMaterial,
  generateLibraryMaterialForTeacher,
  refineMaterialForTeacher,
  listContinuationCandidatesForBooking,
} = await import("@/lib/materials/handlers");

beforeEach(() => {
  state.pro = true;
  state.generationsThisMonth = 0;
  state.generate = { ok: true, body: "# Generated" };
  state.refine = { ok: true, body: "# Refined" };
  refineMaterial.mockClear();
  contentStored = null;
  libraryMaterialStored = null;
  materialFindFirst.mockClear();
  materialFindMany.mockClear();
  continuationRows = [];
  materialCreate.mockClear().mockResolvedValue({ id: "m1" });
  materialUpdate.mockClear().mockResolvedValue({ id: "m1" });
  genCreate.mockClear();
  generateMaterial.mockClear();
  revisionCreate.mockClear();
  revisionFindMany.mockClear().mockResolvedValue([]);
  revisionDeleteMany.mockClear();
  templateFindFirst.mockReset().mockResolvedValue(null);
  levelFindFirst.mockReset().mockResolvedValue({ id: "lvl1", label: "A2" });
  bookingUpdate.mockClear();
  bookingVocabularyOverride = null;
  teacherRow = { targetLanguage: "es" };
  teacherFindUnique.mockClear();
});

describe("saveClassContentForBooking", () => {
  it("blocks a Free teacher with the upgrade nudge and never writes", async () => {
    state.pro = false;
    const r = await saveClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      body: "# Hi",
      source: "manual",
      locale: "en",
    });
    expect(r).toEqual({ ok: false, code: "not-pro", message: "UPGRADE" });
    expect(materialCreate).not.toHaveBeenCalled();
    expect(materialUpdate).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const r = await saveClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      body: "   ",
      source: "manual",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid");
    expect(materialCreate).not.toHaveBeenCalled();
  });

  it("rejects a booking the teacher doesn't own", async () => {
    const r = await saveClassContentForBooking({
      teacherId: "t1",
      bookingId: "nope",
      body: "# Hi",
      source: "manual",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not-found");
    expect(materialCreate).not.toHaveBeenCalled();
  });

  it("creates the content material on the happy path (no existing row)", async () => {
    const r = await saveClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      body: "  # Hi  ",
      source: "ai",
      locale: "en",
    });
    expect(r).toEqual({ ok: true, materialId: "m1" });
    expect(materialCreate).toHaveBeenCalledTimes(1);
    expect(materialUpdate).not.toHaveBeenCalled();
    const arg = (materialCreate.mock.calls as any)[0][0];
    expect(arg.data).toMatchObject({
      teacherId: "t1",
      bookingId: "b1",
      visibility: "at_or_below",
      body: "# Hi",
      contentSource: "ai",
    });
    // Nothing existed before this save — no revision worth snapshotting.
    expect(revisionCreate).not.toHaveBeenCalled();
  });

  it("updates the existing content material when one already exists", async () => {
    contentStored = { id: "m1", body: "# Old", contentSource: "manual" };
    const r = await saveClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      body: "# New",
      source: "ai",
      locale: "en",
    });
    expect(r).toEqual({ ok: true, materialId: "m1" });
    expect(materialUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1" },
        data: { body: "# New", contentSource: "ai" },
      }),
    );
    expect(materialCreate).not.toHaveBeenCalled();
  });

  it("snapshots the outgoing body as a revision when overwriting different existing content", async () => {
    contentStored = { id: "m1", body: "# Old", contentSource: "manual" };
    await saveClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      body: "# New",
      source: "ai",
      locale: "en",
    });
    expect(revisionCreate).toHaveBeenCalledTimes(1);
    const arg = (revisionCreate.mock.calls as any)[0][0];
    expect(arg.data).toMatchObject({
      materialId: "m1",
      teacherId: "t1",
      body: "# Old",
      source: "manual",
    });
  });

  it("does not snapshot a no-op save (identical body)", async () => {
    contentStored = { id: "m1", body: "# Hi", contentSource: "manual" };
    await saveClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      body: "# Hi",
      source: "manual",
      locale: "en",
    });
    expect(revisionCreate).not.toHaveBeenCalled();
  });
});

describe("generateClassContentForBooking", () => {
  it("blocks a Free teacher", async () => {
    state.pro = false;
    const r = await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
    });
    expect(r).toEqual({ ok: false, code: "not-pro", message: "UPGRADE" });
    expect(generateMaterial).not.toHaveBeenCalled();
  });

  it("requires a topic (or a focus/format tag)", async () => {
    const r = await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "  ",
      focusTagIds: [],
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid");
    expect(generateMaterial).not.toHaveBeenCalled();
  });

  it("returns the generated body seeded with level + covered titles, forClass true", async () => {
    const r = await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "Subjunctive",
      focusTagIds: [],
      locale: "en",
    });
    expect(r).toEqual({ ok: true, body: "# Generated" });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.levelLabel).toBe("A2");
    expect(seed.coveredTitles).toEqual(["Unit 1"]);
    expect(seed.forClass).toBe(true);
    // The class's own student name is threaded in so the prompt can pin the one
    // correct name and never reproduce a stray name from the template/profile
    // (the wrong-student-name bug).
    expect(seed.studentName).toBe("Renata Ocampo");
    // A successful generation is recorded for the monthly cap.
    expect(genCreate).toHaveBeenCalledTimes(1);
  });

  it("resolves the class vocabulary override over the teacher default and persists it (D-80)", async () => {
    teacherRow = { targetLanguage: "es", materialVocabulary: "everyday" };
    const r = await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
      vocabulary: "basic",
    });
    expect(r).toEqual({ ok: true, body: "# Generated" });
    // The class override (basic) beats the teacher default (everyday).
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.vocabulary).toBe("basic");
    // And the choice is persisted as this class's override.
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b1" }, data: { vocabularyOverride: "basic" } }),
    );
  });

  it("uses the stored class override when the caller passes none, and doesn't rewrite it (D-80)", async () => {
    bookingVocabularyOverride = "advanced";
    teacherRow = { targetLanguage: "es", materialVocabulary: "basic" };
    await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
      // no `vocabulary` key → leave the stored override alone
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.vocabulary).toBe("advanced");
    expect(bookingUpdate).not.toHaveBeenCalled();
  });

  it("falls back to the teacher default when neither the class nor the call sets vocabulary (D-80)", async () => {
    teacherRow = { targetLanguage: "es", materialVocabulary: "native" };
    await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.vocabulary).toBe("native");
  });

  it("threads the chosen template's structure into the generation seed (D-46)", async () => {
    templateFindFirst.mockResolvedValue({ body: "## Bienvenida\n## Proyecto" });
    const r = await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      templateId: "tpl1",
      locale: "en",
    });
    expect(r).toEqual({ ok: true, body: "# Generated" });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.templateBody).toBe("## Bienvenida\n## Proyecto");
    // Resolved tenant-scoped — id AND teacherId.
    expect(templateFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tpl1", teacherId: "t1" } }),
    );
  });

  it("falls back to no structure for a template id that isn't the teacher's", async () => {
    templateFindFirst.mockResolvedValue(null); // not found for this teacher
    await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      templateId: "foreign",
      locale: "en",
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.templateBody).toBeNull();
  });

  // Language is not a library-only input: a teacher who drafts her library in
  // French wants her classes in French too. This path silently ignored it until
  // the axis was plumbed through every generate surface.
  it("passes the chosen output language through for a class's content", async () => {
    await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      locale: "es-MX",
      language: "French",
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.language).toBe("French");
  });

  it("leaves the language null when unset, so the locale default applies", async () => {
    await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      locale: "es-MX",
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.language).toBeNull();
  });

  // The class-content path resolves the subject the same way the library path
  // does — neither may fall back to letting the model infer one.
  it("seeds the teacher's subject into a class's content prompt too", async () => {
    teacherRow = { targetLanguage: "es" };
    await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "Fractions",
      focusTagIds: [],
      locale: "es-MX",
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.targetLanguage).toBe("Spanish");
    expect(seed.forClass).toBe(true);
  });

  // Lesson continuity ("continue from a previous class"): a teacher can point
  // this generation at one or more previous classes' materials (this
  // student's) so the prompt carries the actual prior content, not just
  // titles.
  describe("continuing from a previous class", () => {
    it("seeds no continuation context when no ids are passed — the resolve query never runs", async () => {
      await generateClassContentForBooking({
        teacherId: "t1",
        bookingId: "b1",
        topic: "x",
        focusTagIds: [],
        locale: "en",
      });
      const seed = (generateMaterial.mock.calls as any)[0][0];
      expect(seed.continueFromMaterials).toEqual([]);
      expect(materialFindMany).not.toHaveBeenCalled();
    });

    it("resolves chosen ids into label+body context, preserving the teacher's selection order", async () => {
      // findMany returns them out of order — the handler must restore the
      // order the ids were given in, not the DB's.
      continuationRows = [
        { id: "prev2", label: "Class 2", body: "Covered numbers." },
        { id: "prev1", label: "Class 1", body: "Covered greetings." },
      ];
      const r = await generateClassContentForBooking({
        teacherId: "t1",
        bookingId: "b1",
        topic: "x",
        focusTagIds: [],
        locale: "en",
        continueFromMaterialIds: ["prev1", "prev2"],
      });
      expect(r).toEqual({ ok: true, body: "# Generated" });
      const seed = (generateMaterial.mock.calls as any)[0][0];
      expect(seed.continueFromMaterials).toEqual([
        { label: "Class 1", body: "Covered greetings." },
        { label: "Class 2", body: "Covered numbers." },
      ]);
    });

    it("scopes the resolve query to this teacher, this student, and excludes the current booking", async () => {
      continuationRows = [{ id: "prev1", label: "Class 1", body: "x" }];
      await generateClassContentForBooking({
        teacherId: "t1",
        bookingId: "b1",
        topic: "x",
        focusTagIds: [],
        locale: "en",
        continueFromMaterialIds: ["prev1"],
      });
      const arg = (materialFindMany.mock.calls as any)[0][0];
      const otherClass = { studentId: "s1", teacherId: "t1", id: { not: "b1" } };
      expect(arg.where).toMatchObject({ id: { in: ["prev1"] }, teacherId: "t1" });
      // Identical to the picker's predicate, so a legitimately-offered id is
      // never silently dropped here and a tampered one still can't escape the
      // teacher/student scope.
      expect(arg.where.OR).toEqual([
        { booking: otherClass },
        { bookingAttachments: { some: { booking: otherClass } } },
        { classUses: { some: { teacherId: "t1", booking: otherClass } } },
      ]);
    });

    it("drops a chosen id that doesn't resolve (deleted, or not this student's) instead of failing", async () => {
      continuationRows = [{ id: "prev1", label: "Class 1", body: "Covered greetings." }];
      const r = await generateClassContentForBooking({
        teacherId: "t1",
        bookingId: "b1",
        topic: "x",
        focusTagIds: [],
        locale: "en",
        continueFromMaterialIds: ["prev1", "gone"],
      });
      expect(r.ok).toBe(true);
      const seed = (generateMaterial.mock.calls as any)[0][0];
      expect(seed.continueFromMaterials).toEqual([
        { label: "Class 1", body: "Covered greetings." },
      ]);
    });

    it("truncates a continuation material's body to the per-material prompt ceiling", async () => {
      const longBody = "x".repeat(5000);
      continuationRows = [{ id: "prev1", label: "Class 1", body: longBody }];
      await generateClassContentForBooking({
        teacherId: "t1",
        bookingId: "b1",
        topic: "x",
        focusTagIds: [],
        locale: "en",
        continueFromMaterialIds: ["prev1"],
      });
      const seed = (generateMaterial.mock.calls as any)[0][0];
      expect(seed.continueFromMaterials[0].body.length).toBe(3000);
    });

    it("caps how many continuation ids it will resolve", async () => {
      const ids = Array.from({ length: 8 }, (_, i) => `prev${i}`);
      continuationRows = [];
      await generateClassContentForBooking({
        teacherId: "t1",
        bookingId: "b1",
        topic: "x",
        focusTagIds: [],
        locale: "en",
        continueFromMaterialIds: ids,
      });
      const arg = (materialFindMany.mock.calls as any)[0][0];
      expect(arg.where.id.in).toHaveLength(5);
      expect(arg.where.id.in).toEqual(ids.slice(0, 5));
    });
  });

  it("blocks once the monthly cap is reached and never calls the model", async () => {
    state.generationsThisMonth = 100;
    const r = await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/limit/i);
    expect(generateMaterial).not.toHaveBeenCalled();
    expect(genCreate).not.toHaveBeenCalled();
  });

  it("does not record a generation when the model fails", async () => {
    state.generate = { ok: false, reason: "error" };
    await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
    });
    expect(genCreate).not.toHaveBeenCalled();
  });

  it("surfaces a friendly error when AI isn't configured", async () => {
    state.generate = { ok: false, reason: "not-configured" };
    const r = await generateClassContentForBooking({
      teacherId: "t1",
      bookingId: "b1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/yourself/i);
  });
});

describe("listContinuationCandidatesForBooking", () => {
  it("returns null for a booking the teacher doesn't own", async () => {
    const r = await listContinuationCandidatesForBooking({ teacherId: "t1", bookingId: "nope" });
    expect(r).toBeNull();
    expect(materialFindMany).not.toHaveBeenCalled();
  });

  it("maps the student's other classes' content materials to candidates", async () => {
    continuationRows = [
      {
        id: "m-prev",
        label: "Greetings",
        body: "We covered hola and buenos días in detail, plus a short dialogue practice.",
        bookingId: "b-prev",
        booking: { id: "b-prev", scheduledStart: new Date("2026-07-10T15:00:00Z") },
        bookingAttachments: [],
        classUses: [],
      },
    ];
    const r = await listContinuationCandidatesForBooking({ teacherId: "t1", bookingId: "b1" });
    expect(r).toEqual([
      {
        materialId: "m-prev",
        bookingId: "b-prev",
        label: "Greetings",
        scheduledStart: "2026-07-10T15:00:00.000Z",
        preview: "We covered hola and buenos días in detail, plus a short dialogue practice.",
      },
    ]);
  });

  it("truncates a long body down to a short preview", async () => {
    continuationRows = [
      {
        id: "m-prev",
        label: null,
        body: "x".repeat(300),
        bookingId: "b-prev",
        booking: { id: "b-prev", scheduledStart: new Date("2026-07-10T15:00:00Z") },
        bookingAttachments: [],
        classUses: [],
      },
    ];
    const r = await listContinuationCandidatesForBooking({ teacherId: "t1", bookingId: "b1" });
    expect(r?.[0].preview.length).toBe(160);
    expect(r?.[0].label).toBeNull();
  });

  it("scopes the candidate query to this student and excludes the current booking", async () => {
    await listContinuationCandidatesForBooking({ teacherId: "t1", bookingId: "b1" });
    const arg = (materialFindMany.mock.calls as any)[0][0];
    const otherClass = { studentId: "s1", teacherId: "t1", id: { not: "b1" } };
    expect(arg.where).toMatchObject({ teacherId: "t1", archived: false, body: { not: null } });
    // Every route into a class is scoped to the SAME other-class predicate, so
    // widening the picker can't reach another student's or teacher's material.
    expect(arg.where.OR).toEqual([
      { booking: otherClass },
      { bookingAttachments: { some: { booking: otherClass } } },
      { classUses: { some: { teacherId: "t1", booking: otherClass } } },
    ]);
  });

  // The gap this widening closes: a class taught off a library worksheet used
  // to offer nothing to continue from, because the material's own `bookingId`
  // is null and no other route was queried.
  it("offers a reusable library item that reached one of this student's classes", async () => {
    continuationRows = [
      {
        id: "m-lib",
        label: "Subjunctive drills",
        body: "Practice set.",
        bookingId: null,
        booking: null,
        bookingAttachments: [
          { booking: { id: "b-prev", scheduledStart: new Date("2026-07-10T15:00:00Z") } },
        ],
        classUses: [],
      },
    ];
    const r = await listContinuationCandidatesForBooking({ teacherId: "t1", bookingId: "b1" });
    expect(r).toEqual([
      {
        materialId: "m-lib",
        bookingId: "b-prev",
        label: "Subjunctive drills",
        scheduledStart: "2026-07-10T15:00:00.000Z",
        preview: "Practice set.",
      },
    ]);
  });

  it("dates a library item by the most recent class of this student that it reached", async () => {
    continuationRows = [
      {
        id: "m-lib",
        label: "Reused",
        body: "Body.",
        bookingId: null,
        booking: null,
        bookingAttachments: [
          { booking: { id: "b-old", scheduledStart: new Date("2026-05-01T15:00:00Z") } },
        ],
        classUses: [
          { booking: { id: "b-recent", scheduledStart: new Date("2026-07-20T15:00:00Z") } },
        ],
      },
    ];
    const r = await listContinuationCandidatesForBooking({ teacherId: "t1", bookingId: "b1" });
    expect(r?.[0].bookingId).toBe("b-recent");
    expect(r?.[0].scheduledStart).toBe("2026-07-20T15:00:00.000Z");
  });

  it("drops a library item that reached none of this student's classes", async () => {
    continuationRows = [
      {
        id: "m-lib",
        label: "Someone else's",
        body: "Body.",
        bookingId: null,
        booking: null,
        bookingAttachments: [],
        classUses: [],
      },
    ];
    expect(
      await listContinuationCandidatesForBooking({ teacherId: "t1", bookingId: "b1" }),
    ).toEqual([]);
  });

  it("orders candidates newest class first across both routes", async () => {
    continuationRows = [
      {
        id: "m-old",
        label: "Old",
        body: "b",
        bookingId: "b-old",
        booking: { id: "b-old", scheduledStart: new Date("2026-05-01T15:00:00Z") },
        bookingAttachments: [],
        classUses: [],
      },
      {
        id: "m-new",
        label: "New",
        body: "b",
        bookingId: null,
        booking: null,
        bookingAttachments: [
          { booking: { id: "b-new", scheduledStart: new Date("2026-08-01T15:00:00Z") } },
        ],
        classUses: [],
      },
    ];
    const r = await listContinuationCandidatesForBooking({ teacherId: "t1", bookingId: "b1" });
    expect(r?.map((c) => c.materialId)).toEqual(["m-new", "m-old"]);
  });
});

describe("saveLibraryContentMaterial", () => {
  it("blocks a Free teacher and never writes", async () => {
    state.pro = false;
    const r = await saveLibraryContentMaterial({
      teacherId: "t1",
      levelId: "lvl1",
      visibility: "at_or_below",
      body: "# Hi",
      source: "manual",
      locale: "en",
    });
    expect(r).toEqual({ ok: false, code: "not-pro", message: "UPGRADE" });
    expect(materialCreate).not.toHaveBeenCalled();
  });

  it("requires a level that belongs to this teacher", async () => {
    levelFindFirst.mockResolvedValue(null);
    const r = await saveLibraryContentMaterial({
      teacherId: "t1",
      levelId: "nope",
      visibility: "at_or_below",
      body: "# Hi",
      source: "manual",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid");
    expect(materialCreate).not.toHaveBeenCalled();
  });

  it("creates a new library item when no materialId is posted", async () => {
    const r = await saveLibraryContentMaterial({
      teacherId: "t1",
      levelId: "lvl1",
      visibility: "all",
      label: "Grammar note",
      body: "# Hi",
      source: "manual",
      locale: "en",
    });
    expect(r).toEqual({ ok: true, materialId: "m1" });
    expect(materialCreate).toHaveBeenCalledTimes(1);
    const arg = (materialCreate.mock.calls as any)[0][0];
    expect(arg.data).toMatchObject({
      teacherId: "t1",
      levelId: "lvl1",
      visibility: "all",
      label: "Grammar note",
      body: "# Hi",
      contentSource: "manual",
    });
  });

  it("edits an existing library content material in place", async () => {
    materialFindFirst.mockResolvedValue({ id: "m1", body: "# Old", contentSource: "manual" });
    const r = await saveLibraryContentMaterial({
      teacherId: "t1",
      materialId: "m1",
      levelId: "lvl1",
      visibility: "at_or_below",
      body: "# New",
      source: "manual",
      locale: "en",
    });
    expect(r).toEqual({ ok: true, materialId: "m1" });
    expect(materialUpdate).toHaveBeenCalledTimes(1);
    expect(materialCreate).not.toHaveBeenCalled();
    // The overwritten body is snapshotted so the edit is undoable.
    expect(revisionCreate).toHaveBeenCalledTimes(1);
  });

  it("leaves an existing link untouched when linkUrl isn't in the input (undefined ≠ clear)", async () => {
    // The destructive half is "" (present-but-empty = clear), which the form
    // guards against by seeding its link input from the stored value. This
    // pins the non-destructive half the seed relies on: an update with no
    // linkUrl key must not write the column at all.
    materialFindFirst.mockResolvedValue({ id: "m1", body: "# Old", contentSource: "manual" });
    const r = await saveLibraryContentMaterial({
      teacherId: "t1",
      materialId: "m1",
      levelId: "lvl1",
      visibility: "at_or_below",
      body: "# New",
      source: "manual",
      locale: "en",
    });
    expect(r).toEqual({ ok: true, materialId: "m1" });
    const arg = (materialUpdate.mock.calls as any)[0][0];
    expect("linkUrl" in arg.data).toBe(false);
    expect("storagePath" in arg.data).toBe(false);
  });

  it("404s when the materialId isn't this teacher's own content item", async () => {
    materialFindFirst.mockResolvedValue(null);
    const r = await saveLibraryContentMaterial({
      teacherId: "t1",
      materialId: "foreign",
      levelId: "lvl1",
      visibility: "at_or_below",
      body: "# New",
      source: "manual",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not-found");
    expect(materialUpdate).not.toHaveBeenCalled();
  });
});

describe("generateLibraryMaterialForTeacher", () => {
  it("blocks a Free teacher", async () => {
    state.pro = false;
    const r = await generateLibraryMaterialForTeacher({
      teacherId: "t1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
    });
    expect(r).toEqual({ ok: false, code: "not-pro", message: "UPGRADE" });
    expect(generateMaterial).not.toHaveBeenCalled();
  });

  it("resolves the chosen level's label into the generation seed", async () => {
    levelFindFirst.mockResolvedValue({ id: "lvl1", label: "B1" });
    const r = await generateLibraryMaterialForTeacher({
      teacherId: "t1",
      topic: "Past tense",
      levelId: "lvl1",
      focusTagIds: [],
      locale: "en",
    });
    expect(r).toEqual({ ok: true, body: "# Generated" });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.levelLabel).toBe("B1");
    expect(seed.forClass).toBe(false);
    expect(genCreate).toHaveBeenCalledTimes(1);
  });

  it("blocks once the monthly cap is reached", async () => {
    state.generationsThisMonth = 100;
    const r = await generateLibraryMaterialForTeacher({
      teacherId: "t1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/limit/i);
    expect(generateMaterial).not.toHaveBeenCalled();
  });

  // The whole point of teachers.target_language: the prompt must name the
  // language taught, or the only concrete noun the model sees is the output
  // language and it infers the subject from that (the pre-fix behavior).
  it("resolves the teacher's language code to its English name for the prompt", async () => {
    teacherRow = { targetLanguage: "fr" };
    await generateLibraryMaterialForTeacher({
      teacherId: "t1",
      topic: "Ordering food",
      focusTagIds: [],
      locale: "es-MX",
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.targetLanguage).toBe("French");
  });

  // Codes outside CLDR still resolve — the whole reason the registry curates
  // Mexican indigenous languages by hand.
  it("resolves a hand-curated indigenous language", async () => {
    teacherRow = { targetLanguage: "nah" };
    await generateLibraryMaterialForTeacher({
      teacherId: "t1",
      topic: "x",
      focusTagIds: [],
      locale: "es-MX",
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.targetLanguage).toBe("Nahuatl");
  });

  it("sends no subject when the teacher has not picked a language", async () => {
    teacherRow = { targetLanguage: null };
    await generateLibraryMaterialForTeacher({
      teacherId: "t1",
      topic: "x",
      focusTagIds: [],
      locale: "en",
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.targetLanguage).toBeNull();
  });

  it("passes the chosen output language through untouched", async () => {
    await generateLibraryMaterialForTeacher({
      teacherId: "t1",
      topic: "x",
      focusTagIds: [],
      locale: "es-MX",
      language: "French",
    });
    const seed = (generateMaterial.mock.calls as any)[0][0];
    expect(seed.language).toBe("French");
  });
});

describe("refineMaterialForTeacher", () => {
  it("blocks a Free teacher with the upgrade nudge and never calls the model", async () => {
    state.pro = false;
    const r = await refineMaterialForTeacher({
      teacherId: "t1",
      currentBody: "# Hi",
      instruction: "shorten it",
      locale: "en",
    });
    expect(r).toEqual({ ok: false, code: "not-pro", message: "UPGRADE" });
    expect(refineMaterial).not.toHaveBeenCalled();
    expect(genCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty instruction", async () => {
    const r = await refineMaterialForTeacher({
      teacherId: "t1",
      currentBody: "# Hi",
      instruction: "   ",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid");
    expect(refineMaterial).not.toHaveBeenCalled();
  });

  it("rejects an empty body — a refine edits what's there, it can't invent one", async () => {
    const r = await refineMaterialForTeacher({
      teacherId: "t1",
      currentBody: "   ",
      instruction: "shorten it",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid");
    expect(refineMaterial).not.toHaveBeenCalled();
  });

  it("blocks at the monthly AI cap and never calls the model", async () => {
    state.generationsThisMonth = 100;
    const r = await refineMaterialForTeacher({
      teacherId: "t1",
      currentBody: "# Hi",
      instruction: "shorten it",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cap");
    expect(refineMaterial).not.toHaveBeenCalled();
    expect(genCreate).not.toHaveBeenCalled();
  });

  it("returns the revised body and burns exactly one generation on success", async () => {
    state.refine = { ok: true, body: "# Refined" };
    const r = await refineMaterialForTeacher({
      teacherId: "t1",
      currentBody: "# Original",
      instruction: "make it shorter",
      locale: "en",
    });
    expect(r).toEqual({ ok: true, body: "# Refined" });
    expect(refineMaterial).toHaveBeenCalledTimes(1);
    expect(genCreate).toHaveBeenCalledTimes(1);
    // The current body + instruction reach the model call.
    const seed = (refineMaterial.mock.calls as any)[0][0];
    expect(seed.currentBody).toBe("# Original");
    expect(seed.instruction).toBe("make it shorter");
  });

  it("does not burn quota when the model call fails", async () => {
    state.refine = { ok: false, reason: "error" };
    const r = await refineMaterialForTeacher({
      teacherId: "t1",
      currentBody: "# Hi",
      instruction: "shorten it",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("error");
    expect(genCreate).not.toHaveBeenCalled();
  });

  it("surfaces not-configured when AI creds are absent", async () => {
    state.refine = { ok: false, reason: "not-configured" };
    const r = await refineMaterialForTeacher({
      teacherId: "t1",
      currentBody: "# Hi",
      instruction: "shorten it",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not-configured");
    expect(genCreate).not.toHaveBeenCalled();
  });

  it("passes the language taught (subject) into the model call", async () => {
    teacherRow = { targetLanguage: "fr" };
    await refineMaterialForTeacher({
      teacherId: "t1",
      currentBody: "# Hi",
      instruction: "shorten it",
      locale: "en",
    });
    const seed = (refineMaterial.mock.calls as any)[0][0];
    // languageName("fr") → "French"
    expect(seed.targetLanguage).toBe("French");
  });
});
