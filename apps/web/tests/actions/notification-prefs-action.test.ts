import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Student notification-prefs save. Unchecked boxes are absent from FormData,
// so present ⇒ on. Scope (lib/students/identity): category prefs + email/push
// opt-in are mailbox-wide (updateMany across the identity set).

vi.mock("@/lib/auth", () => ({
  requireStudent: vi.fn(async () => ({ id: "s1" })),
}));

vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: vi.fn(async () => ["s1", "s2"]),
}));

type Row = { id: string; emailOptIn: boolean; emailOptInAt: Date | null };
type UpdateManyArg = {
  where: { id: { in: string[] }; emailOptIn?: boolean };
  data: {
    emailOptIn: boolean;
    emailOptInAt?: Date;
    pushOptIn?: boolean;
    notificationPrefs?: Record<string, unknown>;
  };
};

// A tiny stateful table, so a test can assert what each identity row ends up
// holding rather than the shape of one call.
const rows = new Map<string, Row>();
const updateMany = vi.fn(async ({ where, data }: UpdateManyArg) => {
  let count = 0;
  for (const id of where.id.in) {
    const row = rows.get(id);
    if (!row) continue;
    if (where.emailOptIn !== undefined && row.emailOptIn !== where.emailOptIn) continue;
    Object.assign(row, data);
    count++;
  }
  return { count };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    student: { updateMany },
  },
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { saveNotificationPrefsAction } = await import("@/app/actions/notification-prefs");

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  rows.set("s1", { id: "s1", emailOptIn: true, emailOptInAt: null });
  rows.set("s2", { id: "s2", emailOptIn: true, emailOptInAt: null });
});

// The call that writes the whole form (prefs + both channels) to every row.
function formWrite(): UpdateManyArg {
  const call = updateMany.mock.calls.find(([arg]) => arg.data.notificationPrefs !== undefined);
  if (!call) throw new Error("no full-form write");
  return call[0];
}

describe("saveNotificationPrefsAction", () => {
  it("writes mailbox-wide prefs across the identity set", async () => {
    const f = new FormData();
    f.set("emailOptIn", "on");
    f.set("pushOptIn", "on");
    const res = await saveNotificationPrefsAction(undefined, f);
    expect(res).toEqual({ ok: true });

    const manyArg = formWrite();
    expect(manyArg.where.id.in).toEqual(["s1", "s2"]);
    expect(manyArg.data.emailOptIn).toBe(true);
    expect(manyArg.data.pushOptIn).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/my-classes/account");
  });

  it("treats absent fields as off", async () => {
    const res = await saveNotificationPrefsAction(undefined, new FormData());
    expect(res).toEqual({ ok: true });
    const manyArg = formWrite();
    expect(manyArg.data.emailOptIn).toBe(false);
    expect(manyArg.data.pushOptIn).toBe(false);
  });

  it("persists per-category channelPrefs nested inside notificationPrefs", async () => {
    const f = new FormData();
    f.set("emailOptIn", "on");
    f.set("pushOptIn", "on");
    // Only supply a restricted channel list for one category (the form omits
    // entries where all channels are selected, i.e. no restriction).
    f.set("channelPrefs", JSON.stringify({ class_reminders: ["push"] }));
    const res = await saveNotificationPrefsAction(undefined, f);
    expect(res).toEqual({ ok: true });

    const manyArg = formWrite();
    const stored = manyArg.data.notificationPrefs!;
    expect(stored["channelPrefs"]).toEqual({ class_reminders: ["push"] });
  });

  it("ignores channelPrefs with unknown categories or channel names", async () => {
    const f = new FormData();
    f.set("emailOptIn", "on");
    f.set(
      "channelPrefs",
      JSON.stringify({
        class_reminders: ["push", "fax"], // "fax" is not a known channel
        bogus_cat: ["email"], // not a known category
      }),
    );
    const res = await saveNotificationPrefsAction(undefined, f);
    expect(res).toEqual({ ok: true });

    const manyArg = formWrite();
    const stored = manyArg.data.notificationPrefs!;
    // "fax" dropped, "bogus_cat" dropped; only "push" survives for class_reminders
    expect(stored["channelPrefs"]).toEqual({ class_reminders: ["push"] });
  });
});

// #155: emailOptInAt existed to date the consent, and nothing ever wrote it.
// It now holds when the opt-in last changed to its current value — so it moves
// on a real change in either direction and stays put on a save that changes
// nothing.
describe("saveNotificationPrefsAction — the date on the email consent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function form(emailOn: boolean): FormData {
    const f = new FormData();
    if (emailOn) f.set("emailOptIn", "on");
    return f;
  }

  it("stamps the withdrawal time on every identity row when she opts out", async () => {
    const withdrawn = new Date("2026-11-16T10:00:00Z");
    vi.setSystemTime(withdrawn);
    await saveNotificationPrefsAction(undefined, form(false));
    expect(rows.get("s1")).toMatchObject({ emailOptIn: false, emailOptInAt: withdrawn });
    expect(rows.get("s2")).toMatchObject({ emailOptIn: false, emailOptInAt: withdrawn });
  });

  it("stamps the consent time when she opts back in", async () => {
    vi.setSystemTime(new Date("2026-11-16T10:00:00Z"));
    await saveNotificationPrefsAction(undefined, form(false));
    const consented = new Date("2026-11-20T09:30:00Z");
    vi.setSystemTime(consented);
    await saveNotificationPrefsAction(undefined, form(true));
    expect(rows.get("s1")).toMatchObject({ emailOptIn: true, emailOptInAt: consented });
    expect(rows.get("s2")).toMatchObject({ emailOptIn: true, emailOptInAt: consented });
  });

  it("does not move the date when a save leaves the opt-in as it was", async () => {
    const withdrawn = new Date("2026-11-16T10:00:00Z");
    vi.setSystemTime(withdrawn);
    await saveNotificationPrefsAction(undefined, form(false));
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    await saveNotificationPrefsAction(undefined, form(false));
    expect(rows.get("s1")!.emailOptInAt).toEqual(withdrawn);
  });

  it("dates only the sibling row whose opt-in actually changed", async () => {
    const earlier = new Date("2026-10-01T00:00:00Z");
    rows.set("s2", { id: "s2", emailOptIn: false, emailOptInAt: earlier });
    const withdrawn = new Date("2026-11-16T10:00:00Z");
    vi.setSystemTime(withdrawn);
    await saveNotificationPrefsAction(undefined, form(false));
    expect(rows.get("s1")!.emailOptInAt).toEqual(withdrawn);
    expect(rows.get("s2")!.emailOptInAt).toEqual(earlier);
  });
});
