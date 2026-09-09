import { beforeEach, describe, expect, it, vi } from "vitest";

// /admin/uat actions (D-55). All five require the superadmin rank OR the
// uat:run capability — requireAdmin is mocked wholesale here (that OR-logic
// is covered directly in tests/lib/admin-nav-visibility.test.ts and
// tests/lib/admin-capabilities.test.ts), so these tests focus on: each
// action calls the right lib/uat/* helper, writes an audit row, and —
// critically — reseedPreviewAction refuses outright when the target isn't
// preview or the deployment is production.

const actor = { id: "admin1", email: "a@x.com", role: "superadmin" as const };
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => actor) }));

const writeOverride = vi.fn(async () => "override-id");
vi.mock("@/lib/audit", () => ({ writeOverride }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const runUatProbe = vi.fn(async () => ({ env: "preview", checks: [], pass: true }));
vi.mock("@/lib/uat/probe", () => ({ runUatProbe }));

const runPostHogCheck = vi.fn(async () => ({ env: "preview", checks: [], pass: true }));
vi.mock("@/lib/uat/posthog-check", () => ({ runPostHogCheck }));

const runStripeCheck = vi.fn(async () => ({ env: "preview", checks: [], pass: true }));
vi.mock("@/lib/uat/stripe-check", () => ({ runStripeCheck }));

const assertReseedAllowed = vi.fn();
vi.mock("@/lib/uat/env-targets", () => ({
  assertReseedAllowed,
  UAT_OVERRIDE_TARGET_IDS: {
    probe: "00000000-0000-0000-0000-000000000101",
    posthogCheck: "00000000-0000-0000-0000-000000000102",
    stripeCheck: "00000000-0000-0000-0000-000000000103",
    reseedPreview: "00000000-0000-0000-0000-000000000104",
  },
}));

// Phase 2a: the reseed producer enqueues through the provider-agnostic seam.
const inngestSend = vi.fn(async () => ({}));
vi.mock("@/lib/jobs/enqueue", () => ({ enqueue: inngestSend }));

type ChecklistRow = { checkedItems: string[] } | null;
type UpsertArgs = { create: { checkedItems: string[] }; update: { checkedItems: string[] } };
const uatChecklistFindUnique = vi.fn(async (): Promise<ChecklistRow> => null);
const uatChecklistUpsert = vi.fn(async (_args: UpsertArgs) => ({}));
type OverrideRow = { action: string; reason: string; afterJson: unknown } | null;
const overrideFindFirst = vi.fn(async (): Promise<OverrideRow> => null);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    uatChecklistState: {
      findUnique: uatChecklistFindUnique,
      upsert: uatChecklistUpsert,
    },
    override: {
      findFirst: overrideFindFirst,
    },
  },
}));

const {
  runUatProbeAction,
  runPostHogCheckAction,
  runStripeCheckAction,
  reseedPreviewAction,
  getReseedStatusAction,
  toggleUatChecklistItemAction,
} = await import("@/app/actions/admin-uat");

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  uatChecklistFindUnique.mockResolvedValue(null);
  overrideFindFirst.mockResolvedValue(null);
});

describe("runUatProbeAction", () => {
  it("rejects an invalid env", async () => {
    const res = await runUatProbeAction(undefined, form({ env: "staging" }));
    expect(res).toHaveProperty("error");
    expect(runUatProbe).not.toHaveBeenCalled();
  });

  it("runs the probe and audits it", async () => {
    const res = await runUatProbeAction(undefined, form({ env: "preview" }));
    expect(runUatProbe).toHaveBeenCalledWith("preview");
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "system", action: "run_uat_probe" }),
    );
    expect(res).toHaveProperty("result");
  });
});

describe("runPostHogCheckAction", () => {
  it("runs the PostHog check and audits it", async () => {
    await runPostHogCheckAction(undefined, form({ env: "production" }));
    expect(runPostHogCheck).toHaveBeenCalledWith("production");
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ action: "run_uat_posthog_check" }),
    );
  });
});

describe("runStripeCheckAction", () => {
  it("passes through the student email and payment id", async () => {
    await runStripeCheckAction(
      undefined,
      form({ env: "preview", studentEmail: "alumno.uat@spiralclass.com", paymentId: "" }),
    );
    expect(runStripeCheck).toHaveBeenCalledWith("preview", {
      studentEmail: "alumno.uat@spiralclass.com",
      paymentId: undefined,
    });
  });
});

describe("reseedPreviewAction", () => {
  it("refuses when assertReseedAllowed throws (production target or deployment)", async () => {
    assertReseedAllowed.mockImplementationOnce(() => {
      throw new Error("Reseed is only allowed against preview, from a non-production deployment.");
    });
    const res = await reseedPreviewAction(undefined, form({ env: "production" }));
    expect(res).toHaveProperty("error");
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("queues the reseed event (defaults) and returns a queuedAt timestamp", async () => {
    const res = await reseedPreviewAction(undefined, form({ env: "preview" }));
    expect(assertReseedAllowed).toHaveBeenCalledWith("preview");
    expect(inngestSend).toHaveBeenCalledWith("admin/uat.reseed-preview", {
      requestedByAdminId: actor.id,
      bulkTeachers: 0,
      studentsPerBulkTeacher: 6,
    });
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ action: "queue_reseed_preview" }),
    );
    const result = res?.result as { queued: boolean; queuedAt: string };
    expect(result.queued).toBe(true);
    expect(new Date(result.queuedAt).toString()).not.toBe("Invalid Date");
  });

  it("passes through custom bulk-volume options", async () => {
    await reseedPreviewAction(
      undefined,
      form({ env: "preview", bulkTeachers: "10", studentsPerBulkTeacher: "3" }),
    );
    expect(inngestSend).toHaveBeenCalledWith("admin/uat.reseed-preview", {
      requestedByAdminId: actor.id,
      bulkTeachers: 10,
      studentsPerBulkTeacher: 3,
    });
  });

  it("rejects an out-of-range bulk-volume option", async () => {
    const res = await reseedPreviewAction(
      undefined,
      form({ env: "preview", bulkTeachers: "9999" }),
    );
    expect(res).toHaveProperty("error");
    expect(inngestSend).not.toHaveBeenCalled();
  });
});

describe("getReseedStatusAction", () => {
  it("reports running when no completion/failure row exists yet", async () => {
    const status = await getReseedStatusAction(new Date().toISOString());
    expect(status).toEqual({ status: "running" });
  });

  it("reports the seed summary once a completion row lands", async () => {
    overrideFindFirst.mockResolvedValueOnce({
      action: "reseed_preview_completed",
      reason: "background job finished",
      afterJson: { teachers: 12, students: 34 },
    });
    const status = await getReseedStatusAction(new Date().toISOString());
    expect(status).toEqual({ status: "completed", summary: { teachers: 12, students: 34 } });
  });

  it("reports the error once a failure row lands", async () => {
    overrideFindFirst.mockResolvedValueOnce({
      action: "reseed_preview_failed",
      reason: "boom",
      afterJson: null,
    });
    const status = await getReseedStatusAction(new Date().toISOString());
    expect(status).toEqual({ status: "failed", error: "boom" });
  });
});

describe("toggleUatChecklistItemAction", () => {
  it("upserts the checked item into a fresh checklist row", async () => {
    await toggleUatChecklistItemAction(
      undefined,
      form({ env: "preview", itemKey: "item-3", checked: "true" }),
    );
    const call = uatChecklistUpsert.mock.calls[0][0];
    expect(call.create.checkedItems).toEqual(["item-3"]);
    expect(call.update.checkedItems).toEqual(["item-3"]);
  });

  it("removes an unchecked item from the existing set", async () => {
    uatChecklistFindUnique.mockResolvedValueOnce({ checkedItems: ["item-1", "item-3"] });
    await toggleUatChecklistItemAction(
      undefined,
      form({ env: "preview", itemKey: "item-1", checked: "false" }),
    );
    const call = uatChecklistUpsert.mock.calls[0][0];
    expect(call.update.checkedItems).toEqual(["item-3"]);
  });
});
