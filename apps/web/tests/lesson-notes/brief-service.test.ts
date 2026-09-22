import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrGenerateBrief } from "@/lib/lesson-notes/brief-service";
import { BriefUnavailableError, type Brief } from "@/lib/lesson-notes/brief";

const ISO = "2026-06-15T15:00:00.000Z";
const PROFILE_JSON = {
  byCategory: {
    grammar: {
      ser_vs_estar: {
        recurrenceCount: 2,
        firstSeenAt: ISO,
        lastSeenAt: ISO,
        trend: "focus",
        lastEvidence: null,
      },
    },
  },
  vocabulary: [],
};
const BRIEF: Brief = { summary: "s", focus: [], vocabulary: [] };

function makeDb(
  opts: {
    profile?: { profile: unknown; updatedAt: Date } | null;
    existing?: { content: unknown; generatedAt: Date } | null;
  } = {},
) {
  const upsert = vi.fn(async () => ({ generatedAt: new Date("2026-06-20T00:00:00Z") }));
  const db = {
    booking: {
      findUnique: vi.fn(async () => ({
        teacherId: "t1",
        studentId: "s1",
        student: { name: "Mira" },
        teacher: { locale: "en" },
      })),
    },
    studentLearningProfile: {
      findUnique: vi.fn(async () =>
        opts.profile === undefined
          ? { profile: PROFILE_JSON, updatedAt: new Date("2026-06-18T00:00:00Z") }
          : opts.profile,
      ),
    },
    lessonBrief: {
      findUnique: vi.fn(async () => opts.existing ?? null),
      upsert,
    },
  };
  return { db, upsert };
}

const generate = vi.fn(async () => ({ brief: BRIEF, model: "claude-haiku-4-5" }));

beforeEach(() => vi.clearAllMocks());

describe("getOrGenerateBrief", () => {
  it("returns null when the student has no profile", async () => {
    const { db } = makeDb({ profile: null });
    const res = await getOrGenerateBrief({ prisma: db as any, generate }, "b1");
    expect(res).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns the cached brief when it's at least as fresh as the profile (no Claude call)", async () => {
    const { db, upsert } = makeDb({
      existing: { content: BRIEF, generatedAt: new Date("2026-06-19T00:00:00Z") }, // after profile.updatedAt (06-18)
    });
    const res = await getOrGenerateBrief({ prisma: db as any, generate }, "b1");
    expect(res?.brief).toEqual(BRIEF);
    expect(generate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("regenerates when the brief is stale (profile changed since)", async () => {
    const { db, upsert } = makeDb({
      existing: { content: BRIEF, generatedAt: new Date("2026-06-17T00:00:00Z") }, // before profile.updatedAt (06-18)
    });
    const res = await getOrGenerateBrief({ prisma: db as any, generate }, "b1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(res?.brief).toEqual(BRIEF);
  });

  it("generates when there is no cached brief", async () => {
    const { db, upsert } = makeDb({ existing: null });
    await getOrGenerateBrief({ prisma: db as any, generate }, "b1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("degrades to null when Claude isn't configured", async () => {
    const { db, upsert } = makeDb({ existing: null });
    const failing = vi.fn(async () => {
      throw new BriefUnavailableError("no key");
    });
    const res = await getOrGenerateBrief({ prisma: db as any, generate: failing }, "b1");
    expect(res).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
});
