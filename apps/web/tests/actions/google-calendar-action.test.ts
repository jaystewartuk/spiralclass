import { beforeEach, describe, expect, it, vi } from "vitest";

// Google Calendar busy-import actions. Disconnect revokes + drops state;
// resync surfaces a sync error; the enable toggle re-syncs when turning on and
// purges imported intervals when turning off.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireTeacher: vi.fn(async () => ({ id: "t1" })) }));

const disconnectGoogleCalendar = vi.fn(async () => {});
vi.mock("@/lib/calendar/google/connection", () => ({ disconnectGoogleCalendar }));

const state = { sync: { status: "ok" } as { status: string; error?: string } };
const syncTeacherBusy = vi.fn(async () => state.sync);
vi.mock("@/lib/calendar/google/sync", () => ({ syncTeacherBusy }));

const connUpdateMany = vi.fn(async () => ({ count: 1 }));
const intervalDeleteMany = vi.fn(async () => ({ count: 3 }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    googleCalendarConnection: { updateMany: connUpdateMany },
    googleBusyInterval: { deleteMany: intervalDeleteMany },
  },
}));

const { disconnectGoogleCalendarAction, resyncGoogleCalendarAction, setGoogleSyncEnabledAction } =
  await import("@/app/actions/google-calendar");

function enabledForm(v: string): FormData {
  const f = new FormData();
  f.set("enabled", v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.sync = { status: "ok" };
});

describe("disconnectGoogleCalendarAction", () => {
  it("disconnects and returns ok", async () => {
    const res = await disconnectGoogleCalendarAction(undefined, new FormData());
    expect(res).toEqual({ ok: true });
    expect(disconnectGoogleCalendar).toHaveBeenCalledWith("t1");
  });
});

describe("resyncGoogleCalendarAction", () => {
  it("returns ok on a successful sync", async () => {
    expect(await resyncGoogleCalendarAction(undefined, new FormData())).toEqual({ ok: true });
  });

  it("surfaces a sync error", async () => {
    state.sync = { status: "error", error: "token expired" };
    expect(await resyncGoogleCalendarAction(undefined, new FormData())).toEqual({
      error: "token expired",
    });
  });
});

describe("setGoogleSyncEnabledAction", () => {
  it("enables sync and triggers a fresh import", async () => {
    const res = await setGoogleSyncEnabledAction(undefined, enabledForm("true"));
    expect(res).toEqual({ ok: true });
    expect(connUpdateMany).toHaveBeenCalledWith({
      where: { teacherId: "t1" },
      data: { syncEnabled: true },
    });
    expect(syncTeacherBusy).toHaveBeenCalledWith("t1");
    expect(intervalDeleteMany).not.toHaveBeenCalled();
  });

  it("disables sync and purges imported intervals", async () => {
    const res = await setGoogleSyncEnabledAction(undefined, enabledForm("false"));
    expect(res).toEqual({ ok: true });
    expect(intervalDeleteMany).toHaveBeenCalledWith({ where: { teacherId: "t1" } });
    expect(syncTeacherBusy).not.toHaveBeenCalled();
  });
});
