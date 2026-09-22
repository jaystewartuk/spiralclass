import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// The two payout-instrument save actions (D-113). Each validates before
// writing and redirects on success; both go through `saveTeacherInstrument`,
// so the `payout_rail_connected` off→on gate is asserted once per kind rather
// than trusted to stay in sync by inspection.

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: async () => "en" }));
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn(), flushAnalytics: vi.fn() }));

// The instrument row as it stands BEFORE the save — null means "no row yet",
// which is what the off→on gate keys on.
const state = {
  existing: null as Record<string, unknown> | null,
};

type SavedInstrument = {
  kind: string;
  enabled: boolean;
  wiseHandle: string | null;
};

const upsert = vi.fn(
  async ({ create, update }: { create?: object; update?: object }): Promise<SavedInstrument> => ({
    kind: "wise",
    enabled: false,
    wiseHandle: null,
    ...(create ?? {}),
    ...(update ?? {}),
  }),
);
const findUnique = vi.fn(async () => state.existing);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherPayoutInstrument: { upsert, findUnique },
    // Backs maybeEmitMarketplaceReady's post-save re-check — null
    // short-circuits it harmlessly, matching this test's focus.
    teacher: { findUnique: async () => null },
  },
}));

const { updateWiseInstrument } = await import("@/app/actions/payout-instruments");
const { trackServerEvent } = await import("@/lib/analytics/posthog");
const trackServerEventMock = trackServerEvent as unknown as Mock;

// A checksum-valid published CLABE (BBVA's canonical test account).

function fd(over: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

function wiseForm(over: Record<string, string> = {}): FormData {
  return fd({
    enabled: "on",
    handle: "alicia.moreno",
    accountHolder: "Alicia Moreno",
    email: "mira@example.com",
    ...over,
  });
}

async function run(
  action: (prev: undefined, f: FormData) => Promise<unknown>,
  f: FormData,
): Promise<{ error?: string } | { redirectTo: string }> {
  try {
    return ((await action(undefined, f)) ?? {}) as { error?: string };
  } catch (err) {
    if (err instanceof RedirectError) return { redirectTo: err.url };
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.existing = null;
});

describe("updateWiseInstrument", () => {
  it("persists the Wise instrument and redirects on success", async () => {
    const res = await run(updateWiseInstrument, wiseForm());
    expect(res).toEqual({ redirectTo: "/settings/payments?wise=1" });
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0] as {
      where: { teacherId_kind: { teacherId: string; kind: string } };
      create: Record<string, unknown>;
    };
    expect(call.where.teacherId_kind).toEqual({ teacherId: "t1", kind: "wise" });
    expect(call.create).toMatchObject({ enabled: true, wiseHandle: "alicia.moreno" });
  });

  it("rejects invalid input without writing", async () => {
    const res = await run(updateWiseInstrument, wiseForm({ email: "not-an-email" }));
    expect(res).toHaveProperty("error");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses to enable without a Wisetag (the CHECK constraint's mirror)", async () => {
    const res = await run(updateWiseInstrument, wiseForm({ handle: "" }));
    expect(res).toHaveProperty("error");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("fires payout_rail_connected (wise) on the not-ready → ready transition", async () => {
    await run(updateWiseInstrument, wiseForm());
    expect(trackServerEventMock).toHaveBeenCalledWith({
      name: "payout_rail_connected",
      distinctId: "t1",
      properties: { teacherId: "t1", rail: "wise" },
    });
  });

  it("does NOT re-fire when the instrument was already ready (a plain re-save)", async () => {
    state.existing = {
      kind: "wise",
      enabled: true,
      wiseHandle: "alicia.moreno",
      schemeId: null,
      details: null,
    };
    await run(updateWiseInstrument, wiseForm());
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(trackServerEventMock).not.toHaveBeenCalled();
  });

  it("does NOT fire when the teacher is pausing the instrument", async () => {
    await run(updateWiseInstrument, wiseForm({ enabled: "" }));
    expect(trackServerEventMock).not.toHaveBeenCalled();
  });

  // The upsert's `update` lists only the form's own fields, so a teacher
  // saving her Wisetag can never clear a live Wise API connection an operator
  // set up for her (lib/wise/credentials.ts writes the same row).
  it("never touches the API credential columns", async () => {
    await run(updateWiseInstrument, wiseForm());
    const call = upsert.mock.calls[0][0] as { create: object; update: object };
    for (const payload of [call.create, call.update]) {
      expect(payload).not.toHaveProperty("wiseApiProfileId");
      expect(payload).not.toHaveProperty("wiseApiTokenEnc");
      expect(payload).not.toHaveProperty("wiseApiKeyEnc");
    }
  });
});
