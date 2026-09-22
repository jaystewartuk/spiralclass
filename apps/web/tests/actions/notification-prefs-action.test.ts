import { beforeEach, describe, expect, it, vi } from "vitest";

// Student notification-prefs save. Unchecked boxes are absent from FormData,
// so present ⇒ on. Scope (lib/students/identity): category prefs + email/push
// opt-in are mailbox-wide (updateMany across the identity set).

vi.mock("@/lib/auth", () => ({
  requireStudent: vi.fn(async () => ({ id: "s1" })),
}));

vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: vi.fn(async () => ["s1", "s2"]),
}));

const updateMany = vi.fn(
  async (_arg: {
    where: { id: { in: string[] } };
    data: { emailOptIn: boolean; pushOptIn: boolean; notificationPrefs: Record<string, boolean> };
  }) => ({ count: 2 }),
);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    student: { updateMany },
  },
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { saveNotificationPrefsAction } = await import("@/app/actions/notification-prefs");

beforeEach(() => vi.clearAllMocks());

describe("saveNotificationPrefsAction", () => {
  it("writes mailbox-wide prefs across the identity set", async () => {
    const f = new FormData();
    f.set("emailOptIn", "on");
    f.set("pushOptIn", "on");
    const res = await saveNotificationPrefsAction(undefined, f);
    expect(res).toEqual({ ok: true });

    const manyArg = updateMany.mock.calls[0][0];
    expect(manyArg.where.id.in).toEqual(["s1", "s2"]);
    expect(manyArg.data.emailOptIn).toBe(true);
    expect(manyArg.data.pushOptIn).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/my-classes/account");
  });

  it("treats absent fields as off", async () => {
    const res = await saveNotificationPrefsAction(undefined, new FormData());
    expect(res).toEqual({ ok: true });
    const manyArg = updateMany.mock.calls[0][0];
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

    const manyArg = updateMany.mock.calls[0][0];
    const stored = manyArg.data.notificationPrefs as Record<string, unknown>;
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

    const manyArg = updateMany.mock.calls[0][0];
    const stored = manyArg.data.notificationPrefs as Record<string, unknown>;
    // "fax" dropped, "bogus_cat" dropped; only "push" survives for class_reminders
    expect(stored["channelPrefs"]).toEqual({ class_reminders: ["push"] });
  });
});
