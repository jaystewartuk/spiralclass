import { describe, expect, it } from "vitest";
import { billingSummary, type BillingSummaryInput } from "./subscriptions-billing-summary";
import { PAST_DUE_GRACE_DAYS } from "./subscriptions-config";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

function sub(over: Partial<NonNullable<BillingSummaryInput>> = {}): BillingSummaryInput {
  return {
    plan: "monthly",
    status: "active",
    comped: false,
    trialEndsAt: null,
    currentPeriodEnd: null,
    ...over,
  };
}

describe("billingSummary", () => {
  it("reports a healthy paid subscription as renewing, and asks for no attention", () => {
    const result = billingSummary(sub({ currentPeriodEnd: daysFromNow(14) }), NOW);
    expect(result.disposition).toBe("renews");
    expect(result.effectiveAt).toEqual(daysFromNow(14));
    expect(result.daysRemaining).toBe(14);
    expect(result.needsAttention).toBe(false);
  });

  // The regression this module exists for. A Customer Portal cancellation
  // leaves the Stripe subscription `active` with the period end untouched, so
  // every field the page used to read says "renewing" and only the flag says
  // otherwise. Reading it as a renewal told a teacher who had JUST cancelled
  // that she was about to be charged again.
  it("reports a portal cancellation as ending, not as the next charge", () => {
    const periodEnd = daysFromNow(14);
    const renewing = billingSummary(sub({ currentPeriodEnd: periodEnd }), NOW);
    const cancelling = billingSummary(
      sub({ currentPeriodEnd: periodEnd, cancelAtPeriodEnd: true }),
      NOW,
    );

    // Same status, same date, opposite meaning.
    expect(renewing.effectiveAt).toEqual(cancelling.effectiveAt);
    expect(renewing.disposition).toBe("renews");
    expect(cancelling.disposition).toBe("ends");
    expect(cancelling.needsAttention).toBe(true);
  });

  it("dates a running trial from trialEndsAt", () => {
    const result = billingSummary(
      sub({ plan: "free", status: "trialing", trialEndsAt: daysFromNow(9) }),
      NOW,
    );
    expect(result.disposition).toBe("trial_ends");
    expect(result.daysRemaining).toBe(9);
    expect(result.needsAttention).toBe(true);
  });

  // effectiveStatus downgrades an elapsed trial to `free` before the sweep
  // catches up; the summary has to follow it rather than keep advertising a
  // trial that is over.
  it("stops advertising a trial whose end has already passed", () => {
    const result = billingSummary(
      sub({ plan: "free", status: "trialing", trialEndsAt: daysFromNow(-1) }),
      NOW,
    );
    expect(result.disposition).toBe("none");
    expect(result.effectiveAt).toBeNull();
  });

  // Past due keeps Pro for the grace window, so the honest date is the END of
  // that window — not the period end that anchors it, which is already behind.
  it("dates a past_due subscription at the end of the grace window", () => {
    const periodEnd = daysFromNow(-2);
    const result = billingSummary(sub({ status: "past_due", currentPeriodEnd: periodEnd }), NOW);
    expect(result.disposition).toBe("grace_ends");
    expect(result.effectiveAt).toEqual(
      new Date(periodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS),
    );
    expect(result.daysRemaining).toBe(PAST_DUE_GRACE_DAYS - 2);
    expect(result.needsAttention).toBe(true);
  });

  it("still asks for attention when a past_due row has no period end to date", () => {
    const result = billingSummary(sub({ status: "past_due", currentPeriodEnd: null }), NOW);
    expect(result.disposition).toBe("none");
    expect(result.effectiveAt).toBeNull();
    expect(result.needsAttention).toBe(true);
  });

  it("drops a past_due subscription whose grace has elapsed", () => {
    const result = billingSummary(
      sub({ status: "past_due", currentPeriodEnd: daysFromNow(-(PAST_DUE_GRACE_DAYS + 1)) }),
      NOW,
    );
    expect(result.disposition).toBe("none");
  });

  // A comped account is full Pro and is never billed, so the dates on its row
  // are noise. Checked before the status so a comped row carrying a stale
  // period end cannot promise a charge.
  it("promises nothing for a comped account, whatever its dates say", () => {
    const result = billingSummary(
      sub({ comped: true, currentPeriodEnd: daysFromNow(14), cancelAtPeriodEnd: true }),
      NOW,
    );
    expect(result).toEqual({
      disposition: "none",
      effectiveAt: null,
      daysRemaining: null,
      needsAttention: false,
    });
  });

  it("promises nothing on Free, on a canceled row, or with no subscription at all", () => {
    expect(billingSummary(sub({ plan: "free", status: "free" }), NOW).disposition).toBe("none");
    expect(
      billingSummary(sub({ status: "canceled", currentPeriodEnd: daysFromNow(3) }), NOW)
        .disposition,
    ).toBe("none");
    expect(billingSummary(null, NOW).disposition).toBe("none");
  });

  it("rounds a partial last day up, so nothing reads as 0 days while it is still live", () => {
    const inSixHours = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
    expect(billingSummary(sub({ currentPeriodEnd: inSixHours }), NOW).daysRemaining).toBe(1);
  });

  // `effectiveStatus` does not downgrade an `active` row on its period end —
  // only Stripe's next webhook moves it — so a lagging delivery leaves a live
  // subscription whose renewal date is already behind. Reachable, and the one
  // place an unclamped countdown would render "-3 days".
  it("never counts down past zero when a period end is already behind", () => {
    const result = billingSummary(sub({ currentPeriodEnd: daysFromNow(-3) }), NOW);
    expect(result.disposition).toBe("renews");
    expect(result.daysRemaining).toBe(0);
  });
});
