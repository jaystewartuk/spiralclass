import { describe, expect, it } from "vitest";
import {
  canStudentRescheduleBooking,
  classifyStudentCancel,
  decideStudentCancel,
  scheduleChangeBudget,
} from "@/lib/cancellation/classify";

const HOUR = 60 * 60 * 1000;

describe("classifyStudentCancel", () => {
  const start = new Date("2026-04-30T18:00:00Z");

  it("classifies exactly 24h ahead as gte24h (boundary inclusive on the eligible side)", () => {
    const now = new Date(start.getTime() - 24 * HOUR);
    const c = classifyStudentCancel({ now, scheduledStart: start });
    expect(c.timing).toBe("gte24h");
    expect(c.eligibleForReschedule).toBe(true);
    expect(c.deductsClass).toBe(false);
  });

  it("classifies 24h00m01s ahead as gte24h", () => {
    const now = new Date(start.getTime() - 24 * HOUR - 1000);
    expect(classifyStudentCancel({ now, scheduledStart: start }).timing).toBe("gte24h");
  });

  it("classifies 23h59m59s ahead as lt24h (deducted, no reschedule)", () => {
    const now = new Date(start.getTime() - 24 * HOUR + 1000);
    const c = classifyStudentCancel({ now, scheduledStart: start });
    expect(c.timing).toBe("lt24h");
    expect(c.eligibleForReschedule).toBe(false);
    expect(c.deductsClass).toBe(true);
  });

  it("classifies a past-start cancel (post-class no-action) as lt24h", () => {
    const now = new Date(start.getTime() + 5 * HOUR);
    expect(classifyStudentCancel({ now, scheduledStart: start }).timing).toBe("lt24h");
  });
});

describe("scheduleChangeBudget", () => {
  it("is one pooled change per class in the package", () => {
    expect(scheduleChangeBudget(10)).toBe(10);
    expect(scheduleChangeBudget(1)).toBe(1);
    expect(scheduleChangeBudget(0)).toBe(0);
  });
});

describe("canStudentRescheduleBooking", () => {
  const start = new Date("2026-04-30T18:00:00Z");

  it("ok when status=scheduled, budget left, ≥24h", () => {
    const r = canStudentRescheduleBooking({
      now: new Date(start.getTime() - 48 * HOUR),
      scheduledStart: start,
      status: "scheduled",
      scheduleChangesUsed: 0,
      scheduleChangesAllowed: 10,
    });
    expect(r.ok).toBe(true);
  });

  it("still ok with budget partly spent (pooled, not per-booking)", () => {
    const r = canStudentRescheduleBooking({
      now: new Date(start.getTime() - 48 * HOUR),
      scheduledStart: start,
      status: "scheduled",
      scheduleChangesUsed: 3,
      scheduleChangesAllowed: 10,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects when booking is not scheduled (already canceled / completed)", () => {
    const r = canStudentRescheduleBooking({
      now: new Date(start.getTime() - 48 * HOUR),
      scheduledStart: start,
      status: "canceled_by_student",
      scheduleChangesUsed: 0,
      scheduleChangesAllowed: 10,
    });
    expect(r).toEqual({ ok: false, reason: "booking-not-scheduled" });
  });

  it("rejects when the package's schedule-change budget is spent", () => {
    const r = canStudentRescheduleBooking({
      now: new Date(start.getTime() - 48 * HOUR),
      scheduledStart: start,
      status: "scheduled",
      scheduleChangesUsed: 10,
      scheduleChangesAllowed: 10,
    });
    expect(r).toEqual({ ok: false, reason: "schedule-changes-exhausted" });
  });

  it("rejects when within 24h", () => {
    const r = canStudentRescheduleBooking({
      now: new Date(start.getTime() - 12 * HOUR),
      scheduledStart: start,
      status: "scheduled",
      scheduleChangesUsed: 0,
      scheduleChangesAllowed: 10,
    });
    expect(r).toEqual({ ok: false, reason: "lt24h" });
  });
});

describe("decideStudentCancel", () => {
  const start = new Date("2026-04-30T18:00:00Z");

  it("<24h: forfeits the class, never charges the budget, never blocked", () => {
    const d = decideStudentCancel({
      now: new Date(start.getTime() - 2 * HOUR),
      scheduledStart: start,
      scheduleChangesUsed: 0,
      scheduleChangesAllowed: 10,
    });
    expect(d).toEqual({
      timing: "lt24h",
      refundsClass: false,
      chargesScheduleChange: false,
      blockedExhausted: false,
    });
  });

  it("≥24h with budget left: refunds the class and spends one schedule change", () => {
    const d = decideStudentCancel({
      now: new Date(start.getTime() - 48 * HOUR),
      scheduledStart: start,
      scheduleChangesUsed: 3,
      scheduleChangesAllowed: 10,
    });
    expect(d).toEqual({
      timing: "gte24h",
      refundsClass: true,
      chargesScheduleChange: true,
      blockedExhausted: false,
    });
  });

  it("≥24h with budget spent: blocked (no free-move refund left)", () => {
    const d = decideStudentCancel({
      now: new Date(start.getTime() - 48 * HOUR),
      scheduledStart: start,
      scheduleChangesUsed: 10,
      scheduleChangesAllowed: 10,
    });
    expect(d).toEqual({
      timing: "gte24h",
      refundsClass: false,
      chargesScheduleChange: false,
      blockedExhausted: true,
    });
  });

  it("<24h is never blocked even when the budget is spent (forfeit always allowed)", () => {
    const d = decideStudentCancel({
      now: new Date(start.getTime() - 1 * HOUR),
      scheduledStart: start,
      scheduleChangesUsed: 10,
      scheduleChangesAllowed: 10,
    });
    expect(d.blockedExhausted).toBe(false);
    expect(d.timing).toBe("lt24h");
  });
});
