import { beforeEach, describe, expect, it, vi } from "vitest";

// Package-template edit/archive — `saveTemplatesAction` is the
// onboarding-wizard form handler. It iterates the parallel arrays of
// `tpl_id` / `tpl_kind` / etc., parses through templatesSchema, and
// either marks each row archived (keep="0") or updates it (keep="1").
//
// Slice 1 doesn't allow inserting new templates — rows without an id
// are silently skipped. This test pins both the edit and the archive
// paths so a future "add new template" wiring lands intentionally.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";

type TemplateRow = {
  id: string;
  teacherId: string;
  name: string;
  subject?: string | null;
  classCount: number;
  singleClass: boolean;
  classDurationMin: number;
  priceMinorUnits: number;
  currency: string;
  transferPriceMinorUnits: number | null;
  expirationMonths: number | null;
  archived: boolean;
};

const state: { templates: Map<string, TemplateRow> } = {
  templates: new Map(),
};

const revalidateMock = vi.fn();

class TestRedirect extends Error {
  constructor(public path: string) {
    super(`redirect:${path}`);
  }
}

// The teacher's country decides whether a Wise price is even meaningful — a
// teacher outside the Connect circle has no card rail for it to discount
// against (D-58) — so it has to be part of this stub rather than absent.
// Mutable, so a test can put her outside the circle.
const teacherStub = { id: TEACHER_ID, country: "GB" };

vi.mock("@/lib/auth", () => ({
  requireTeacher: vi.fn(async () => teacherStub),
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidateMock,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new TestRedirect(path);
  }),
}));

vi.mock("@/lib/prisma", () => {
  // Field-guarded conditional update — honors the teacher-scoped WHERE
  // (`{ id, teacherId }`), so a foreign id matches 0 rows (silent no-op)
  // instead of mutating another tenant's row.
  function packageTemplateUpdateMany({ where, data }: any) {
    const row = state.templates.get(where.id);
    if (!row) return { count: 0 };
    if (where.teacherId !== undefined && row.teacherId !== where.teacherId) {
      return { count: 0 };
    }
    Object.assign(row, data);
    return { count: 1 };
  }
  function packageTemplateCreate({ data }: any) {
    const id = `tpl-new-${state.templates.size + 1}`;
    const row: TemplateRow = {
      id,
      teacherId: data.teacherId,
      name: data.name,
      subject: data.subject ?? null,
      classCount: data.classCount,
      singleClass: data.singleClass ?? false,
      classDurationMin: data.classDurationMin,
      priceMinorUnits: data.priceMinorUnits,
      currency: data.currency ?? "MXN",
      transferPriceMinorUnits: data.transferPriceMinorUnits ?? null,
      expirationMonths: data.expirationMonths ?? null,
      archived: false,
    };
    state.templates.set(id, row);
    return { ...row };
  }
  const tx = {
    packageTemplate: {
      updateMany: packageTemplateUpdateMany,
      create: packageTemplateCreate,
    },
    // saveTemplatesAction now stamps
    // templatesTouchedAt on every real submit, inside the same transaction.
    teacher: {
      update: async () => ({}),
    },
  };
  return {
    prisma: {
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
      // Free-cap gate reads these. A trialing subscription (new teachers start
      // on the Pro trial) so the onboarding wizard isn't capped.
      packageTemplate: {
        count: async () => state.templates.size,
        // Read back by the SETTINGS save, which returns the surviving set to
        // the editor instead of redirecting.
        findMany: async ({ where }: any) =>
          [...state.templates.values()]
            .filter((r) => r.teacherId === where.teacherId && r.archived === where.archived)
            .map((r) => ({
              id: r.id,
              name: r.name,
              subject: r.subject ?? null,
              classCount: r.classCount,
              singleClass: r.singleClass,
              classDurationMin: r.classDurationMin,
              priceMinorUnits: r.priceMinorUnits,
              transferPriceMinorUnits: r.transferPriceMinorUnits,
              expirationMonths: r.expirationMonths,
            })),
      },
      // findUnique backs maybeEmitMarketplaceReady's post-transaction re-check
      // — null short-circuits it
      // harmlessly, matching this test's focus (template edit/archive), not
      // activation.
      teacher: {
        findUnique: async () => null,
      },
      teacherSubscription: {
        findUnique: async () => ({
          plan: "free",
          status: "trialing",
          comped: false,
          trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          currentPeriodEnd: null,
        }),
      },
    },
  };
});

const { saveTemplatesAction } = await import("@/app/actions/onboarding");

function freshState() {
  state.templates.clear();
  state.templates.set("tpl-1", {
    id: "tpl-1",
    teacherId: TEACHER_ID,
    name: "4 clases / 1 mes",
    classCount: 4,
    singleClass: false,
    classDurationMin: 50,
    priceMinorUnits: 130_000,
    currency: "MXN",
    transferPriceMinorUnits: null,
    expirationMonths: 1,
    archived: false,
  });
  state.templates.set("tpl-2", {
    id: "tpl-2",
    teacherId: TEACHER_ID,
    name: "8 clases / 1 mes",
    classCount: 8,
    singleClass: false,
    classDurationMin: 50,
    priceMinorUnits: 240_000,
    currency: "MXN",
    transferPriceMinorUnits: null,
    expirationMonths: 1,
    archived: false,
  });
  state.templates.set("tpl-3", {
    id: "tpl-3",
    teacherId: TEACHER_ID,
    name: "10 clases / 3 meses",
    classCount: 10,
    singleClass: false,
    classDurationMin: 50,
    priceMinorUnits: 280_000,
    currency: "MXN",
    transferPriceMinorUnits: null,
    expirationMonths: 3,
    archived: false,
  });
  state.templates.set("tpl-4", {
    id: "tpl-4",
    teacherId: TEACHER_ID,
    name: "20 clases / 5 meses",
    classCount: 20,
    singleClass: false,
    classDurationMin: 50,
    priceMinorUnits: 550_000,
    currency: "MXN",
    transferPriceMinorUnits: null,
    expirationMonths: 5,
    archived: false,
  });
}

function form(
  rows: Array<{
    id: string;
    name: string;
    classCount: string;
    duration: string;
    price: string; // pesos
    expiration: string;
    keep: "1" | "";
    singleClass?: "1" | "0";
    subject?: string;
    wisePrice?: string; // pesos; blank = no Wise override
  }>,
) {
  const fd = new FormData();
  for (const r of rows) {
    fd.append("tpl_id", r.id);
    fd.append("tpl_name", r.name);
    // Always appended so the parallel getAll() arrays stay index-aligned.
    fd.append("tpl_subject", r.subject ?? "");
    fd.append("tpl_single_class", r.singleClass ?? "0");
    fd.append("tpl_class_count", r.classCount);
    fd.append("tpl_duration", r.duration);
    fd.append("tpl_price", r.price);
    fd.append("tpl_wise_price", r.wisePrice ?? "");
    fd.append("tpl_expiration", r.expiration);
    fd.append("tpl_keep", r.keep);
  }
  return fd;
}

async function runAndCaptureRedirect(fd: FormData): Promise<string | undefined> {
  try {
    const result = await saveTemplatesAction(undefined, fd);
    if (result?.error) return undefined;
    throw new Error("expected redirect");
  } catch (err) {
    if (err instanceof TestRedirect) return err.path;
    throw err;
  }
}

beforeEach(() => {
  freshState();
  revalidateMock.mockClear();
});

describe("saveTemplatesAction — edit path", () => {
  it("updates name + price + classCount on a kept row, normalizes major units to minor units", async () => {
    const path = await runAndCaptureRedirect(
      form([
        {
          id: "tpl-1",
          name: "4 clases mensuales (renombrado)",
          classCount: "4",
          duration: "60",
          price: "1500", // pesos
          expiration: "1",
          keep: "1",
        },
        {
          id: "tpl-2",
          name: "8 clases / 1 mes",
          classCount: "8",
          duration: "50",
          price: "2400",
          expiration: "1",
          keep: "1",
        },
        {
          id: "tpl-3",
          name: "10 clases / 3 meses",
          classCount: "10",
          duration: "50",
          price: "2800",
          expiration: "3",
          keep: "1",
        },
        {
          id: "tpl-4",
          name: "20 clases / 5 meses",
          classCount: "20",
          duration: "50",
          price: "5500",
          expiration: "5",
          keep: "1",
        },
      ]),
    );
    expect(path).toBe("/onboarding/preview");
    expect(state.templates.get("tpl-1")).toMatchObject({
      name: "4 clases mensuales (renombrado)",
      classDurationMin: 60,
      priceMinorUnits: 150_000, // 1500 pesos × 100
      archived: false,
    });
    // Untouched rows are still updated (idempotent re-write); archived=false.
    expect(state.templates.get("tpl-2")?.archived).toBe(false);
    expect(state.templates.get("tpl-3")?.archived).toBe(false);
    expect(state.templates.get("tpl-4")?.archived).toBe(false);
  });

  it("normalizes an optional Wise price to minor units via the currency helper", async () => {
    const path = await runAndCaptureRedirect(
      form([
        {
          id: "tpl-1",
          name: "4 clases",
          classCount: "4",
          duration: "60",
          price: "1500",
          wisePrice: "1400", // pesos; Wise discount override
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    expect(path).toBe("/onboarding/preview");
    expect(state.templates.get("tpl-1")).toMatchObject({
      priceMinorUnits: 150_000,
      transferPriceMinorUnits: 140_000, // 1400 pesos × 100 (MXN exponent)
    });
  });

  it("DROPS a Wise price for a teacher with no card rail to discount against", async () => {
    // Checkout charges `transferPriceMinorUnits ?? priceMinorUnits`
    // (lib/payments/instruments.ts). A teacher with no card rail has no Stripe
    // price to discount against, so a stored Wise price is not a discount — it
    // is silently THE price, and the form hides every control that could change
    // it. That combination is how a booking page came to advertise 2,600 while
    // students were charged 2,500.
    //
    // The EXAMPLE country changed at D-143, the protection did not. This case
    // used MX, because the pre-D-143 card rail was Stripe's cross-border payout
    // circle and Mexico sat outside it. Direct charges settle on the teacher's
    // own account, so MX is now firmly ON the card rail and a Mexican teacher's
    // Wise price is a real discount again. NG is used instead: Stripe refuses a
    // merchant configuration there (measured, see SUPPORTED_CONNECT_COUNTRIES),
    // so she genuinely has only the manual transfer rail — which is exactly the
    // shape this guards.
    //
    // Enforced server-side because the form is one client; a stale hidden
    // input must not be able to reinstate it.
    const previous = teacherStub.country;
    teacherStub.country = "NG";
    try {
      await runAndCaptureRedirect(
        form([
          {
            id: "tpl-1",
            name: "4 clases",
            classCount: "4",
            duration: "60",
            price: "1500",
            wisePrice: "1400",
            expiration: "1",
            keep: "1",
          },
        ]),
      );
      expect(state.templates.get("tpl-1")).toMatchObject({
        priceMinorUnits: 150_000,
        transferPriceMinorUnits: null,
      });
    } finally {
      teacherStub.country = previous;
    }
  });
});

describe("saveTemplatesAction — archive path", () => {
  it("flips archived=true on rows where keep is unchecked", async () => {
    await runAndCaptureRedirect(
      form([
        {
          id: "tpl-1",
          name: "4",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "",
        },
        {
          id: "tpl-2",
          name: "8",
          classCount: "8",
          duration: "50",
          price: "2400",
          expiration: "1",
          keep: "1",
        },
        {
          id: "tpl-3",
          name: "10",
          classCount: "10",
          duration: "50",
          price: "2800",
          expiration: "3",
          keep: "1",
        },
        {
          id: "tpl-4",
          name: "20",
          classCount: "20",
          duration: "50",
          price: "5500",
          expiration: "5",
          keep: "",
        },
      ]),
    );
    expect(state.templates.get("tpl-1")?.archived).toBe(true);
    expect(state.templates.get("tpl-2")?.archived).toBe(false);
    expect(state.templates.get("tpl-3")?.archived).toBe(false);
    expect(state.templates.get("tpl-4")?.archived).toBe(true);
  });

  it("archive does not alter the row's other fields", async () => {
    await runAndCaptureRedirect(
      form([
        {
          id: "tpl-1",
          name: "ignored-rename",
          classCount: "99",
          duration: "120",
          price: "9999",
          expiration: "12",
          keep: "",
        },
      ]),
    );
    const row = state.templates.get("tpl-1")!;
    expect(row.name).toBe("4 clases / 1 mes");
    expect(row.priceMinorUnits).toBe(130_000);
    expect(row.archived).toBe(true);
  });
});

describe("saveTemplatesAction — create path (package templates audit follow-up)", () => {
  it("inserts a template carrying expirationMonths", async () => {
    await runAndCaptureRedirect(
      form([
        {
          id: "",
          name: "15 clases / 4 meses",
          classCount: "15",
          duration: "50",
          price: "4000",
          expiration: "4",
          keep: "1",
        },
      ]),
    );
    const created = Array.from(state.templates.values()).find(
      (r) => r.name === "15 clases / 4 meses",
    );
    expect(created).toMatchObject({
      classCount: 15,
      priceMinorUnits: 400_000,
      currency: "MXN",
      expirationMonths: 4,
    });
  });

  it("inserts an additional template alongside the four starters", async () => {
    await runAndCaptureRedirect(
      form([
        {
          id: "",
          name: "12 clases / 2 meses",
          classCount: "12",
          duration: "50",
          price: "3000",
          expiration: "2",
          keep: "1",
        },
        {
          id: "tpl-1",
          name: "4 clases / 1 mes",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    expect(state.templates.size).toBe(5);
    const created = Array.from(state.templates.values()).find(
      (r) => r.name === "12 clases / 2 meses",
    );
    expect(created).toMatchObject({
      classCount: 12,
      classDurationMin: 50,
      priceMinorUnits: 300_000,
      expirationMonths: 2,
      archived: false,
    });
  });

  it("persists a subject on create and coerces a blank subject to null", async () => {
    await runAndCaptureRedirect(
      form([
        {
          id: "",
          name: "8 clases / 1 mes",
          classCount: "8",
          duration: "50",
          price: "2400",
          expiration: "1",
          keep: "1",
          subject: "Conversación",
        },
        {
          id: "",
          name: "4 clases / 1 mes",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    const withSubject = Array.from(state.templates.values()).find(
      (r) => r.name === "8 clases / 1 mes" && r.id.startsWith("tpl-new"),
    );
    const withoutSubject = Array.from(state.templates.values()).find(
      (r) => r.name === "4 clases / 1 mes" && r.id.startsWith("tpl-new"),
    );
    expect(withSubject?.subject).toBe("Conversación");
    expect(withoutSubject?.subject).toBe(null);
  });

  it("updates the subject on an existing kept row", async () => {
    await runAndCaptureRedirect(
      form([
        {
          id: "tpl-1",
          name: "4 clases / 1 mes",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "1",
          subject: "Gramática",
        },
      ]),
    );
    expect(state.templates.get("tpl-1")?.subject).toBe("Gramática");
  });

  it("creates an individual class with classCount pinned to 1", async () => {
    await runAndCaptureRedirect(
      form([
        {
          id: "",
          name: "Clase suelta",
          // A stray class count must be ignored for a single class.
          classCount: "7",
          duration: "50",
          price: "300",
          expiration: "1",
          keep: "1",
          singleClass: "1",
        },
      ]),
    );
    const created = Array.from(state.templates.values()).find((r) => r.name === "Clase suelta");
    expect(created).toMatchObject({
      singleClass: true,
      classCount: 1,
      priceMinorUnits: 30_000,
    });
  });

  it("id-less + keep='' is a no-op (teacher created and removed in same submit)", async () => {
    await runAndCaptureRedirect(
      form([
        {
          id: "",
          name: "Throwaway",
          classCount: "5",
          duration: "50",
          price: "1000",
          expiration: "1",
          keep: "",
        },
        {
          id: "tpl-1",
          name: "4 clases / 1 mes",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    expect(state.templates.size).toBe(4);
    for (const r of state.templates.values()) {
      expect(r.name).not.toBe("Throwaway");
    }
  });
});

describe("saveTemplatesAction — cross-tenant isolation", () => {
  const OTHER_TEACHER = "99999999-9999-4999-8999-999999999999";

  it("cannot edit another teacher's template by posting its id", async () => {
    state.templates.set("foreign-1", {
      id: "foreign-1",
      teacherId: OTHER_TEACHER,
      name: "Mira's package",
      classCount: 8,
      singleClass: false,
      classDurationMin: 50,
      priceMinorUnits: 240_000,
      currency: "MXN",
      transferPriceMinorUnits: null,
      expirationMonths: 1,
      archived: false,
    });

    await runAndCaptureRedirect(
      form([
        {
          id: "foreign-1",
          name: "hijacked",
          classCount: "1",
          duration: "50",
          price: "1",
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    // The foreign row is untouched — the teacher-scoped WHERE matched 0 rows.
    expect(state.templates.get("foreign-1")).toMatchObject({
      name: "Mira's package",
      priceMinorUnits: 240_000,
    });
  });

  it("cannot archive another teacher's template by posting its id with keep=''", async () => {
    state.templates.set("foreign-2", {
      id: "foreign-2",
      teacherId: OTHER_TEACHER,
      name: "Mira's other package",
      classCount: 4,
      singleClass: false,
      classDurationMin: 50,
      priceMinorUnits: 130_000,
      currency: "MXN",
      transferPriceMinorUnits: null,
      expirationMonths: 1,
      archived: false,
    });

    await runAndCaptureRedirect(
      form([
        {
          id: "foreign-2",
          name: "x",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "",
        },
      ]),
    );
    expect(state.templates.get("foreign-2")?.archived).toBe(false);
  });
});

describe("saveTemplatesAction — unkept rows never block (reported bug)", () => {
  it("ignores a blank new row the teacher added and then removed (keep='')", async () => {
    const path = await runAndCaptureRedirect(
      form([
        {
          id: "tpl-1",
          name: "4",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "1",
        },
        {
          id: "tpl-2",
          name: "8",
          classCount: "8",
          duration: "50",
          price: "2400",
          expiration: "1",
          keep: "1",
        },
        {
          id: "tpl-3",
          name: "10",
          classCount: "10",
          duration: "50",
          price: "2800",
          expiration: "3",
          keep: "1",
        },
        {
          id: "tpl-4",
          name: "20",
          classCount: "20",
          duration: "50",
          price: "5500",
          expiration: "5",
          keep: "1",
        },
        // The blank, unkept row that used to fail server validation:
        { id: "", name: "", classCount: "", duration: "", price: "", expiration: "", keep: "" },
      ]),
    );
    expect(path).toBe("/onboarding/preview");
    // Nothing was created for the removed blank row.
    expect(state.templates.size).toBe(4);
  });

  it("archives an existing row even when its content was blanked out", async () => {
    const path = await runAndCaptureRedirect(
      form([
        {
          id: "tpl-1",
          name: "",
          classCount: "",
          duration: "",
          price: "",
          expiration: "",
          keep: "",
        },
        {
          id: "tpl-2",
          name: "8",
          classCount: "8",
          duration: "50",
          price: "2400",
          expiration: "1",
          keep: "1",
        },
        {
          id: "tpl-3",
          name: "10",
          classCount: "10",
          duration: "50",
          price: "2800",
          expiration: "3",
          keep: "1",
        },
        {
          id: "tpl-4",
          name: "20",
          classCount: "20",
          duration: "50",
          price: "5500",
          expiration: "5",
          keep: "1",
        },
      ]),
    );
    expect(path).toBe("/onboarding/preview");
    expect(state.templates.get("tpl-1")?.archived).toBe(true);
  });
});

describe("saveTemplatesAction — validation", () => {
  it("returns a form error when classCount is non-positive", async () => {
    const result = await saveTemplatesAction(
      undefined,
      form([
        {
          id: "tpl-1",
          name: "4 clases",
          classCount: "0",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    expect(result?.error).toBeTruthy();
    // No mutation if validation rejects.
    expect(state.templates.get("tpl-1")?.classCount).toBe(4);
  });

  it("returns a form error when priceMinorUnits would be negative (negative pesos in the form)", async () => {
    const result = await saveTemplatesAction(
      undefined,
      form([
        {
          id: "tpl-1",
          name: "4 clases",
          classCount: "4",
          duration: "50",
          price: "-100",
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    expect(result?.error).toBeTruthy();
  });

  it("rejects templates submitted without an expirationMonths", async () => {
    const result = await saveTemplatesAction(
      undefined,
      form([
        {
          id: "tpl-1",
          name: "4 clases",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "",
          keep: "1",
        },
      ]),
    );
    expect(result?.error).toBeTruthy();
  });

  it("points the error at the offending package (2nd row) and its index", async () => {
    const result = await saveTemplatesAction(
      undefined,
      form([
        {
          id: "tpl-1",
          name: "4 clases",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "1",
        },
        // Missing name on the second kept row.
        {
          id: "tpl-2",
          name: "",
          classCount: "8",
          duration: "50",
          price: "2400",
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    expect(result?.error).toContain("2");
    expect(result?.templateIndex).toBe(1);
    // No mutation when validation rejects.
    expect(state.templates.get("tpl-2")?.name).toBe("8 clases / 1 mes");
  });
});

// The SETTINGS save does not redirect. /settings/templates is the page the
// teacher is already on and working in, so bouncing her through a server
// redirect to say "saved" threw away her scroll position and every open
// package card; the action returns the surviving set instead, and the editor
// re-baselines its unsaved-changes model from it. The onboarding wizard still
// redirects — its next step is a different page.
describe("saveTemplatesAction — the settings return path", () => {
  function settingsForm(rows: Parameters<typeof form>[0]): FormData {
    const fd = form(rows);
    fd.append("redirectTo", "/settings/templates");
    return fd;
  }

  it("returns the saved set rather than redirecting", async () => {
    const result = await saveTemplatesAction(
      undefined,
      settingsForm([
        {
          id: "tpl-1",
          name: "4 clases (renombrado)",
          classCount: "4",
          duration: "50",
          price: "1400",
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    expect(result?.ok).toBe(true);
    expect(result?.error).toBeUndefined();
    const saved = result?.templates ?? [];
    expect(saved.find((t) => t.id === "tpl-1")).toMatchObject({
      name: "4 clases (renombrado)",
      priceMinorUnits: 140_000,
    });
  });

  it("gives a row created this session its server id, so a second save updates it", async () => {
    // Without the id the editor would post an id-less row again and create a
    // duplicate on every subsequent save.
    const before = state.templates.size;
    const result = await saveTemplatesAction(
      undefined,
      settingsForm([
        {
          id: "",
          name: "12 clases / 3 meses",
          classCount: "12",
          duration: "50",
          price: "3300",
          expiration: "3",
          keep: "1",
        },
      ]),
    );
    expect(state.templates.size).toBe(before + 1);
    const created = (result?.templates ?? []).find((t) => t.name === "12 clases / 3 meses");
    expect(created?.id).toBeTruthy();
  });

  it("omits an archived row from what it hands back", async () => {
    const result = await saveTemplatesAction(
      undefined,
      settingsForm([
        {
          id: "tpl-1",
          name: "4 clases",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "",
        },
      ]),
    );
    expect(state.templates.get("tpl-1")?.archived).toBe(true);
    expect((result?.templates ?? []).some((t) => t.id === "tpl-1")).toBe(false);
  });

  it("still reports a validation error, with no ok and no set", async () => {
    const result = await saveTemplatesAction(
      undefined,
      settingsForm([
        {
          id: "tpl-1",
          name: "",
          classCount: "4",
          duration: "50",
          price: "1300",
          expiration: "1",
          keep: "1",
        },
      ]),
    );
    expect(result?.ok).toBeUndefined();
    expect(result?.templates).toBeUndefined();
    expect(result?.templateIndex).toBe(0);
  });
});
