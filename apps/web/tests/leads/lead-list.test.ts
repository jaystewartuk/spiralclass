import { describe, expect, it } from "vitest";

// The pure view decisions behind /dashboard/leads — which view was asked for,
// what the search box searched for, how long someone has been waiting, and
// whether a conversion percentage is worth printing. No database, no React.

import {
  conversionRate,
  CONVERSION_RATE_MIN_LEADS,
  DEFAULT_LEAD_SCOPE,
  elapsedSince,
  LEAD_SCOPE_STATUSES,
  LEAD_SEARCH_MAX_LENGTH,
  leadsHref,
  mailtoHref,
  normalizeLeadSearch,
  RELATIVE_MAX_DAYS,
  replyUrgency,
  REPLY_DUE_HOURS,
  REPLY_OVERDUE_HOURS,
  resolveLeadScope,
  whatsappHref,
} from "@/lib/leads/list";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("resolveLeadScope", () => {
  it("accepts the three real views", () => {
    expect(resolveLeadScope("open")).toBe("open");
    expect(resolveLeadScope("converted")).toBe("converted");
    expect(resolveLeadScope("archived")).toBe("archived");
  });

  it("falls back to the default rather than erroring on junk", () => {
    // A hand-edited or stale link is a view preference that went bad, not a
    // 404 — she should still see her leads.
    expect(resolveLeadScope(undefined)).toBe(DEFAULT_LEAD_SCOPE);
    expect(resolveLeadScope("nonsense")).toBe(DEFAULT_LEAD_SCOPE);
    expect(resolveLeadScope("")).toBe(DEFAULT_LEAD_SCOPE);
  });

  it("takes the first value when the param is repeated", () => {
    expect(resolveLeadScope(["archived", "open"])).toBe("archived");
  });
});

describe("LEAD_SCOPE_STATUSES", () => {
  it("keeps `new` and `contacted` together as one working set", () => {
    expect(LEAD_SCOPE_STATUSES.open).toEqual(["new", "contacted"]);
  });

  it("covers every status exactly once across the three views", () => {
    const all = Object.values(LEAD_SCOPE_STATUSES).flatMap((statuses) => [...statuses]);
    expect([...all].sort()).toEqual(["archived", "contacted", "converted", "new"]);
  });
});

describe("normalizeLeadSearch", () => {
  it("trims and collapses absence to an empty string", () => {
    expect(normalizeLeadSearch("  mira  ")).toBe("mira");
    expect(normalizeLeadSearch(undefined)).toBe("");
  });

  it("caps the term so a `contains` filter can't become an unbounded scan", () => {
    const long = "a".repeat(LEAD_SEARCH_MAX_LENGTH + 40);
    expect(normalizeLeadSearch(long)).toHaveLength(LEAD_SEARCH_MAX_LENGTH);
  });
});

describe("leadsHref", () => {
  it("omits the default scope so the canonical URL stays clean", () => {
    expect(leadsHref("open")).toBe("/dashboard/leads");
    expect(leadsHref("archived")).toBe("/dashboard/leads?show=archived");
  });

  it("carries a search across a view change", () => {
    expect(leadsHref("converted", "mira")).toBe("/dashboard/leads?show=converted&q=mira");
    expect(leadsHref("open", "mira")).toBe("/dashboard/leads?q=mira");
  });

  it("encodes a term that would otherwise break the query string", () => {
    expect(leadsHref("open", "a&b=c")).toBe("/dashboard/leads?q=a%26b%3Dc");
  });
});

describe("elapsedSince", () => {
  it("names the largest unit that is still a whole number", () => {
    expect(elapsedSince(ago(30 * 1000), NOW)).toEqual({ unit: "now", count: 0 });
    expect(elapsedSince(ago(5 * MINUTE), NOW)).toEqual({ unit: "minutes", count: 5 });
    expect(elapsedSince(ago(3 * HOUR), NOW)).toEqual({ unit: "hours", count: 3 });
    expect(elapsedSince(ago(4 * DAY), NOW)).toEqual({ unit: "days", count: 4 });
  });

  it("floors rather than rounds, so it never overstates the age", () => {
    expect(elapsedSince(ago(59 * MINUTE + 59 * 1000), NOW)).toEqual({
      unit: "minutes",
      count: 59,
    });
    expect(elapsedSince(ago(47 * HOUR), NOW)).toEqual({ unit: "days", count: 1 });
  });

  it("clamps a future timestamp to `now` instead of printing a negative", () => {
    // A few seconds of clock skew between the app server and Postgres is
    // enough to produce one of these.
    expect(elapsedSince(new Date(NOW.getTime() + 30 * 1000), NOW)).toEqual({
      unit: "now",
      count: 0,
    });
  });

  it("keeps counting in days past the point the row switches to a date", () => {
    // The unit doesn't stop at RELATIVE_MAX_DAYS — the row decides to print a
    // calendar date instead, and needs the true count to make that call.
    expect(elapsedSince(ago((RELATIVE_MAX_DAYS + 120) * DAY), NOW).count).toBe(
      RELATIVE_MAX_DAYS + 120,
    );
  });
});

describe("replyUrgency", () => {
  it("is silent about anything she has already replied to", () => {
    const old = ago(30 * DAY);
    expect(replyUrgency("contacted", old, NOW)).toBe("none");
    expect(replyUrgency("converted", old, NOW)).toBe("none");
    expect(replyUrgency("archived", old, NOW)).toBe("none");
  });

  it("stays quiet for the first day, then escalates", () => {
    expect(replyUrgency("new", ago(2 * HOUR), NOW)).toBe("none");
    expect(replyUrgency("new", ago(REPLY_DUE_HOURS * HOUR), NOW)).toBe("due");
    expect(replyUrgency("new", ago(48 * HOUR), NOW)).toBe("due");
    expect(replyUrgency("new", ago(REPLY_OVERDUE_HOURS * HOUR), NOW)).toBe("overdue");
  });

  it("treats a future timestamp as brand new, not as overdue", () => {
    expect(replyUrgency("new", new Date(NOW.getTime() + HOUR), NOW)).toBe("none");
  });
});

describe("the waiting badge's two halves agree", () => {
  it("never asks the catalog for a plural of zero days", () => {
    // The badge prints `waitingDays` with the count from `elapsedSince`, and
    // only when `replyUrgency` says something. Those are two thresholds in two
    // functions, and they have to coincide exactly: a `due` verdict at 23
    // hours would render "Waiting 0 days". They do — REPLY_DUE_HOURS is 24 and
    // a day is 24 hours — and this is what keeps them that way.
    for (let hours = 0; hours <= 200; hours++) {
      const createdAt = ago(hours * HOUR);
      if (replyUrgency("new", createdAt, NOW) === "none") continue;
      const elapsed = elapsedSince(createdAt, NOW);
      expect(elapsed.unit).toBe("days");
      expect(elapsed.count).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("conversionRate", () => {
  it("withholds a percentage until it is a measurement rather than a coin flip", () => {
    expect(conversionRate(1, 2)).toBeNull();
    expect(conversionRate(0, 0)).toBeNull();
    expect(conversionRate(1, CONVERSION_RATE_MIN_LEADS - 1)).toBeNull();
  });

  it("rounds to whole percent once there are enough leads", () => {
    expect(conversionRate(1, 5)).toBe(20);
    expect(conversionRate(1, 3 + 4)).toBe(14);
    expect(conversionRate(10, 10)).toBe(100);
    expect(conversionRate(0, 20)).toBe(0);
  });
});

describe("contact links", () => {
  it("strips everything but digits for wa.me", () => {
    // WhatsApp answers a `+`, a space or a dash with a "not on WhatsApp"
    // screen, which reads as the contact being wrong rather than the link.
    expect(whatsappHref("+52 55 1234 5678")).toBe("https://wa.me/525512345678");
    expect(whatsappHref("+447700900123")).toBe("https://wa.me/447700900123");
  });

  it("percent-encodes the address and the subject", () => {
    expect(mailtoHref("mira@example.mx", "About your classes")).toBe(
      "mailto:mira%40example.mx?subject=About%20your%20classes",
    );
  });
});
