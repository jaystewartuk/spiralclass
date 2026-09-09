import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared lead-lifecycle core (lib/leads/status), used by both the web
// dashboard action. Asserts teacher-scoping, the not-found
// path, and that only real transitions emit analytics (never the `new` state).

const updateMany = vi.fn();
const trackServerEvent = vi.fn();
const flushAnalytics = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/prisma", () => ({
  prisma: { lead: { updateMany: (...args: unknown[]) => updateMany(...args) } },
}));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: (...args: unknown[]) => trackServerEvent(...args),
  flushAnalytics: () => flushAnalytics(),
}));

import { applyLeadStatus } from "@/lib/leads/status";

const TEACHER = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  updateMany.mockReset();
  trackServerEvent.mockReset();
  flushAnalytics.mockClear();
});

describe("applyLeadStatus", () => {
  it("scopes the update to the owning teacher", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await applyLeadStatus(TEACHER, LEAD, "contacted");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: LEAD, teacherId: TEACHER },
      data: { status: "contacted" },
    });
  });

  it("returns false (and emits nothing) when no row matches", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const ok = await applyLeadStatus(TEACHER, LEAD, "converted");
    expect(ok).toBe(false);
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("emits the mapped transition event for real transitions", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await applyLeadStatus(TEACHER, LEAD, "converted");
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "lead_converted", distinctId: TEACHER }),
    );
    expect(flushAnalytics).toHaveBeenCalled();
  });

  it("does not emit an event when restoring to 'new'", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    const ok = await applyLeadStatus(TEACHER, LEAD, "new");
    expect(ok).toBe(true);
    expect(trackServerEvent).not.toHaveBeenCalled();
  });
});
