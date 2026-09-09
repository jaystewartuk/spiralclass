import { beforeEach, describe, expect, it, vi } from "vitest";

// Retry flow:
//   1. requireAdmin("support") allows the call (mocked).
//   2. Notification status is reset to 'queued' and error/failedAt cleared.
//   3. The dispatcher event `notification.queued` is re-emitted with the
//      notification id + teacher id.

const NOTIF_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_ID = "22222222-2222-4222-8222-222222222222";

type NotifRow = {
  id: string;
  teacherId: string;
  status: string;
  error: string | null;
  failedAt: Date | null;
};

const state: { notif: NotifRow | null } = { notif: null };

function freshState(overrides: Partial<NotifRow> = {}) {
  state.notif = {
    id: NOTIF_ID,
    teacherId: TEACHER_ID,
    status: "failed",
    error: "boom",
    failedAt: new Date(),
    ...overrides,
  };
}

const emitMock = vi.fn(async () => {});
const revalidatePathMock = vi.fn();

vi.mock("@/lib/admin", () => ({
  requireAdmin: vi.fn(async () => ({ id: "admin-1", email: "a@b.co", role: "support" })),
}));

vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: emitMock,
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.notif && where.id === state.notif.id ? { ...state.notif } : null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<NotifRow> }) => {
        if (!state.notif || where.id !== state.notif.id) throw new Error("missing");
        Object.assign(state.notif, data);
        return state.notif;
      },
    },
  },
}));

const { retryNotificationAction } = await import("@/app/actions/admin-notifications");

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  emitMock.mockClear();
  revalidatePathMock.mockClear();
});

describe("retryNotificationAction", () => {
  it("resets a failed notification to queued and re-emits the event", async () => {
    freshState({ status: "failed" });
    const res = await retryNotificationAction(undefined, form({ notificationId: NOTIF_ID }));
    expect(res?.ok).toBe(true);
    expect(state.notif?.status).toBe("queued");
    expect(state.notif?.error).toBeNull();
    expect(state.notif?.failedAt).toBeNull();
    expect(emitMock).toHaveBeenCalledWith({
      notificationId: NOTIF_ID,
      teacherId: TEACHER_ID,
    });
  });

  it("refuses to retry a notification already sent", async () => {
    freshState({ status: "sent", error: null, failedAt: null });
    const res = await retryNotificationAction(undefined, form({ notificationId: NOTIF_ID }));
    expect(res?.error).toMatch(/sent/);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("returns an error when the notification doesn't exist", async () => {
    state.notif = null;
    const res = await retryNotificationAction(undefined, form({ notificationId: NOTIF_ID }));
    expect(res?.error).toBe("Notificación no encontrada");
    expect(emitMock).not.toHaveBeenCalled();
  });
});
