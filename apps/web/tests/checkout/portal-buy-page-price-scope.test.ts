import { beforeEach, describe, expect, it, vi } from "vitest";

// /my-classes/buy — pins WHICH STUDENT ROW the page prices against, not its
// markup.
//
// The page used to resolve agreed prices across the whole identity set
// (`grandfatheredPricesForAny`) while `createPortalCheckoutIntent` resolved
// them for the single pairing row it charges through. When those two rows
// differ — a second pairing with the same teacher on a sibling student row,
// which "one row per (teacher, email)" permits because it is an app invariant
// and not a DB constraint — the page rendered an agreed price, labelled it
// "tu precio acordado", and the student was charged the catalog price.
//
// So the assertion is narrow and deliberate: the price query is scoped to ONE
// student id, and it is the pairing row's. A `{ in: [...] }` here is the bug.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const LINKED_ID = "22222222-2222-4222-8222-aaaaaaaaaaaa";
const PAIRING_ID = "22222222-2222-4222-8222-bbbbbbbbbbbb";

const PAIRING = {
  // The pairing the portal offers — a sibling row, not the linked row, which
  // is the whole reason the two resolutions could disagree.
  studentId: PAIRING_ID,
  teacher: {
    id: TEACHER_ID,
    name: "Alicia Moreno",
    stripeAccountId: null,
    stripeChargesEnabled: false,
    pricingCurrency: "MXN",
    payoutInstruments: [],
    packageTemplates: [
      {
        id: "tmpl-1",
        name: "Individual class",
        classCount: 1,
        classDurationMin: 50,
        priceMinorUnits: 50_000,
        transferPriceMinorUnits: null,
        expirationMonths: 1,
      },
    ],
  },
};
const teacherStudentFindMany = vi.fn(async (_args: { select: Record<string, unknown> }) => [
  PAIRING,
]);
const templatePriceFindMany = vi.fn(async (_args: { where: unknown }) => [
  { templateId: "tmpl-1", priceMinorUnits: 2_000 },
]);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: {
      findMany: (...a: unknown[]) =>
        teacherStudentFindMany(...(a as Parameters<typeof teacherStudentFindMany>)),
    },
    teacherStudentTemplatePrice: {
      findMany: (...a: unknown[]) =>
        templatePriceFindMany(...(a as Parameters<typeof templatePriceFindMany>)),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireStudent: async () => ({ id: LINKED_ID, email: "jay@example.com" }),
}));
// The identity set legitimately spans both rows — what must NOT span them is
// the price lookup.
vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: async () => [LINKED_ID, PAIRING_ID],
}));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "es-MX",
  getT: async () => (k: string) => k,
}));
vi.mock("@/app/actions/checkout", () => ({ createPortalCheckoutIntent: () => {} }));

const page = (await import("@/app/(student)/my-classes/buy/page")).default;

// This suite pins the page's QUERY SHAPE, not its markup, and the unit project
// transforms server components without a JSX runtime (see
// student/class-detail-page-queries.test.ts, which short-circuits on notFound
// for the same reason). Every query under test has been issued by the time the
// page reaches its `return`, so a render failure past that point is not a
// result — swallow it and assert on the calls.
async function runPageQueries() {
  await page({ searchParams: Promise.resolve({}) }).catch(() => undefined);
}

describe("/my-classes/buy price scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prices against the pairing row alone, never the identity set", async () => {
    await runPageQueries();

    expect(templatePriceFindMany).toHaveBeenCalledTimes(1);
    const where = templatePriceFindMany.mock.calls[0]![0].where;
    expect(where).toEqual({ teacherId: TEACHER_ID, studentId: PAIRING_ID });
  });

  it("selects the pairing row's id, without which the page cannot scope at all", async () => {
    await runPageQueries();

    const select = teacherStudentFindMany.mock.calls[0]![0].select;
    expect(select.studentId).toBe(true);
  });

  it("prices a duplicated pairing from the oldest row, the one checkout uses", async () => {
    // Two pairings with the same teacher across sibling student rows. The
    // query is ordered createdAt asc, so the first is the one purchasingLinkFor
    // resolves; pricing from the second would quote a number no checkout can
    // charge, and would list Mira twice in the picker under a duplicate key.
    teacherStudentFindMany.mockResolvedValueOnce([PAIRING, { ...PAIRING, studentId: LINKED_ID }]);

    await runPageQueries();

    expect(templatePriceFindMany.mock.calls[0]![0].where).toEqual({
      teacherId: TEACHER_ID,
      studentId: PAIRING_ID,
    });
  });
});
