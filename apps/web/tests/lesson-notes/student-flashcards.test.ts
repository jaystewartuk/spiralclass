import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

// What a student's vocabulary flashcards may show (#302, see "What the student
// sees" in docs/features/lesson-insights-reports.md):
//
// 1. Cards follow the progress-sharing switch. A term seeded while a teacher
//    shared progress used to stay due after she turned sharing off, because the
//    due-card read filtered by student only.
// 2. A card is the term and nothing else. Its back used to be the confirmed
//    LessonInsight's evidence and suggestion: text the insights prompt writes
//    TO the teacher, in HER reading language, about the student ("drill estar
//    with her"), quoting the student's words as spoken, mistakes included.
//
// The page is rendered as a Server Component against a fake Prisma that
// honours the where clauses the page sends, so a read that forgets the switch
// returns the unshared row exactly as Postgres would.

type Pair = { teacherId: string; studentId: string };
type Review = Pair & { id: string; term: string; dueAt: Date };

const PAST = new Date("2026-01-01T00:00:00Z");
const IDS = ["s-shared", "s-unshared"];

const pairings = [
  { teacherId: "t-shared", studentId: "s-shared", shareProgress: true, name: "Shared teacher" },
  { teacherId: "t-unshared", studentId: "s-unshared", shareProgress: false, name: "Other" },
];
const reviews: Review[] = [
  { id: "r-shared", teacherId: "t-shared", studentId: "s-shared", term: "cansado", dueAt: PAST },
  {
    id: "r-unshared",
    teacherId: "t-unshared",
    studentId: "s-unshared",
    term: "mercado",
    dueAt: PAST,
  },
];
const PRIVATE_EVIDENCE = "yo soy muy cansado";
const PRIVATE_SUGGESTION = "Drill estar for states with her next class";

type Where = {
  studentId?: { in: string[] };
  teacherId?: string;
  dueAt?: { lte: Date };
  OR?: Pair[];
};
function matches(row: Review, where: Where): boolean {
  if (where.studentId && !where.studentId.in.includes(row.studentId)) return false;
  if (where.teacherId !== undefined && row.teacherId !== where.teacherId) return false;
  if (where.dueAt && row.dueAt > where.dueAt.lte) return false;
  if (
    where.OR &&
    !where.OR.some((p) => p.teacherId === row.teacherId && p.studentId === row.studentId)
  )
    return false;
  return true;
}

const lessonInsightFindMany = vi.fn(async () => [
  {
    teacherId: "t-shared",
    summary: "cansado",
    evidence: PRIVATE_EVIDENCE,
    suggestion: PRIVATE_SUGGESTION,
    createdAt: PAST,
    booking: { studentId: "s-shared" },
  },
]);

const prisma = {
  teacherStudent: {
    findMany: vi.fn(
      async ({ where }: { where: { studentId: { in: string[] }; shareProgress: boolean } }) =>
        pairings
          .filter(
            (p) =>
              where.studentId.in.includes(p.studentId) && p.shareProgress === where.shareProgress,
          )
          .map((p) => ({
            teacherId: p.teacherId,
            studentId: p.studentId,
            teacher: { name: p.name },
          })),
    ),
  },
  studentLearningProfile: {
    findMany: vi.fn(async ({ where }: { where: { OR: Pair[] } }) =>
      where.OR.filter((p) => p.teacherId === "t-shared").map((p) => ({
        ...p,
        profile: {
          byCategory: {},
          vocabulary: [{ term: "cansado", lastSeenAt: PAST.toISOString() }],
          speakingBalance: null,
        },
      })),
    ),
  },
  vocabularyReview: {
    createMany: vi.fn(async () => ({ count: 0 })),
    // Honours `select` as Prisma does, so a card carries what the page asked for.
    findMany: vi.fn(
      async ({ where, select }: { where: Where; select: Partial<Record<keyof Review, true>> }) =>
        reviews
          .filter((r) => matches(r, where))
          .map((r) =>
            Object.fromEntries(Object.keys(select).map((k) => [k, r[k as keyof Review]])),
          ),
    ),
  },
  lessonInsight: { findMany: lessonInsightFindMany },
};

vi.mock("@/lib/prisma", () => ({ prisma }));
vi.mock("@/lib/auth", () => ({ requireStudent: vi.fn(async () => ({ id: "s-shared" })) }));
vi.mock("@/lib/i18n", () => ({ getT: vi.fn(async () => (key: string) => key) }));
vi.mock("@/lib/students/identity", () => ({ studentIdentityIds: vi.fn(async () => IDS) }));
vi.mock("@/app/actions/student-vocab", () => ({ gradeVocabulary: vi.fn() }));

const { default: ProgressPage } = await import("@/app/(student)/my-classes/progress/page");
const { VocabReview } = await import("@/app/(student)/my-classes/progress/vocab-review");

function findElement(node: ReactNode, type: unknown): ReactElement<{ terms: unknown[] }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const element = node as ReactElement<{ children?: ReactNode; terms: unknown[] }>;
  if (element.type === type) return element;
  return findElement(element.props.children, type);
}

async function renderedCards(): Promise<unknown[]> {
  const tree = await ProgressPage();
  return findElement(tree, VocabReview)?.props.terms ?? [];
}

describe("a student's vocabulary flashcards", () => {
  it("show no due card from a pairing whose progress is not shared", async () => {
    const cards = (await renderedCards()) as { id: string }[];
    expect(cards.map((c) => c.id)).toEqual(["r-shared"]);
  });

  it("are the term alone, with none of the teacher's insight text on the back", async () => {
    const cards = await renderedCards();
    expect(cards).toEqual([{ id: "r-shared", term: "cansado" }]);
    expect(JSON.stringify(cards)).not.toContain(PRIVATE_EVIDENCE);
    expect(JSON.stringify(cards)).not.toContain(PRIVATE_SUGGESTION);
    expect(lessonInsightFindMany).not.toHaveBeenCalled();
  });
});
