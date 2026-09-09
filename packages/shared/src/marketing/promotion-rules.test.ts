import { describe, expect, it } from "vitest";
import {
  communityAllowsLink,
  DEFAULT_PROMOTION_RULES,
  describePromotionRules,
  daysUntilNextPromotionWeekday,
  hasPromotionRules,
  normalizeEveryDays,
  normalizeWeekdays,
  promotionAllowedOnWeekday,
  promotionWindow,
  weekdayLabels,
  PROMO_EVERY_DAYS_MAX,
  type PromotionRules,
} from "./promotion-rules";

const rules = (over: Partial<PromotionRules> = {}): PromotionRules => ({
  ...DEFAULT_PROMOTION_RULES,
  ...over,
});

describe("normalizeWeekdays", () => {
  it("dedupes, sorts and drops anything outside 0..6", () => {
    expect(normalizeWeekdays([3, 1, 3, 9, -1, 0])).toEqual([0, 1, 3]);
  });

  it("accepts the strings a form posts", () => {
    expect(normalizeWeekdays(["5", "1"])).toEqual([1, 5]);
  });

  it("collapses 'every day selected' to the empty array", () => {
    // One canonical representation of one meaning: all seven and none both say
    // "any day", and storing them differently would make the two look like
    // different rules on the card.
    expect(normalizeWeekdays([0, 1, 2, 3, 4, 5, 6])).toEqual([]);
  });

  it("treats a non-array as no rule rather than throwing on a page render", () => {
    expect(normalizeWeekdays(null)).toEqual([]);
    expect(normalizeWeekdays("monday")).toEqual([]);
  });
});

describe("normalizeEveryDays", () => {
  it("keeps a sensible number and floors it", () => {
    expect(normalizeEveryDays(14)).toBe(14);
    expect(normalizeEveryDays("7")).toBe(7);
    expect(normalizeEveryDays(3.9)).toBe(3);
  });

  it("reads a cleared, zero or nonsense field as no frequency rule", () => {
    expect(normalizeEveryDays("")).toBe(null);
    expect(normalizeEveryDays(0)).toBe(null);
    expect(normalizeEveryDays(-5)).toBe(null);
    expect(normalizeEveryDays("soon")).toBe(null);
    expect(normalizeEveryDays(undefined)).toBe(null);
  });

  it("caps a typo rather than locking a community for years", () => {
    expect(normalizeEveryDays(100000)).toBe(PROMO_EVERY_DAYS_MAX);
  });
});

describe("communityAllowsLink", () => {
  it("follows the platform when the community has no opinion", () => {
    // Facebook places links inline; Reddit does not.
    expect(
      communityAllowsLink({ platform: "facebook_group", promoPolicy: "open", rules: rules() }),
    ).toBe(true);
    expect(communityAllowsLink({ platform: "reddit", promoPolicy: "open", rules: rules() })).toBe(
      false,
    );
  });

  it("lets an explicit no override a platform that would allow one", () => {
    expect(
      communityAllowsLink({
        platform: "facebook_group",
        promoPolicy: "open",
        rules: rules({ linksAllowed: false }),
      }),
    ).toBe(false);
  });

  it("lets an explicit yes open a platform whose culture says otherwise", () => {
    expect(
      communityAllowsLink({
        platform: "instagram",
        promoPolicy: "limited",
        rules: rules({ linksAllowed: true }),
      }),
    ).toBe(true);
  });

  it("never lets an explicit yes reopen a closed policy", () => {
    // The policy gate is what keeps "help her market" from becoming "help her
    // get removed"; a per-community override must not be able to lift it.
    for (const promoPolicy of ["prohibited", "unknown"] as const) {
      expect(
        communityAllowsLink({
          platform: "facebook_group",
          promoPolicy,
          rules: rules({ linksAllowed: true }),
        }),
      ).toBe(false);
    }
  });
});

describe("promotionAllowedOnWeekday", () => {
  it("treats no configured days as any day", () => {
    expect(promotionAllowedOnWeekday(rules(), 0)).toBe(true);
    expect(promotionAllowedOnWeekday(rules(), 4)).toBe(true);
  });

  it("permits only the configured days once she sets some", () => {
    const friday = rules({ weekdays: [5] });
    expect(promotionAllowedOnWeekday(friday, 5)).toBe(true);
    expect(promotionAllowedOnWeekday(friday, 4)).toBe(false);
  });
});

describe("daysUntilNextPromotionWeekday", () => {
  it("is today when no days are configured", () => {
    expect(daysUntilNextPromotionWeekday(rules(), 3)).toBe(0);
  });

  it("counts forward, wrapping across the week boundary", () => {
    const monday = rules({ weekdays: [1] });
    expect(daysUntilNextPromotionWeekday(monday, 1)).toBe(0);
    expect(daysUntilNextPromotionWeekday(monday, 6)).toBe(2);
    expect(daysUntilNextPromotionWeekday(monday, 2)).toBe(6);
  });
});

describe("promotionWindow", () => {
  const now = new Date("2026-09-03T12:00:00Z");

  it("is open when nothing is configured", () => {
    expect(promotionWindow({ rules: rules(), weekday: 4, now })).toEqual({ allowed: true });
  });

  it("closes on a day the community does not allow, and names the next one", () => {
    const result = promotionWindow({ rules: rules({ weekdays: [5] }), weekday: 3, now });
    expect(result).toEqual({ allowed: false, reason: "weekday", inDays: 2 });
  });

  it("closes when she promoted here inside the frequency window", () => {
    const result = promotionWindow({
      rules: rules({ everyDays: 14 }),
      weekday: 4,
      now,
      lastPromotedAt: new Date("2026-08-30T12:00:00Z"),
    });
    expect(result).toMatchObject({ allowed: false, reason: "frequency" });
    if (!result.allowed && result.reason === "frequency") {
      expect(result.nextAllowedAt.toISOString()).toBe("2026-09-13T12:00:00.000Z");
    }
  });

  it("reopens once the gap has passed", () => {
    expect(
      promotionWindow({
        rules: rules({ everyDays: 7 }),
        weekday: 4,
        now,
        lastPromotedAt: new Date("2026-08-01T12:00:00Z"),
      }),
    ).toEqual({ allowed: true });
  });

  it("cannot be closed by a frequency rule she has never triggered", () => {
    // A draft she never posted is not a promotion; only a post she marked done
    // sets `lastPromotedAt`, so a fresh community is never pre-blocked.
    expect(
      promotionWindow({ rules: rules({ everyDays: 30 }), weekday: 4, now, lastPromotedAt: null }),
    ).toEqual({ allowed: true });
  });

  it("reports the frequency rule first when both would close the window", () => {
    // The one that reopens LAST is the one she needs to know about.
    const result = promotionWindow({
      rules: rules({ weekdays: [5], everyDays: 30 }),
      weekday: 3,
      now,
      lastPromotedAt: new Date("2026-09-01T12:00:00Z"),
    });
    expect(result).toMatchObject({ reason: "frequency" });
  });
});

describe("describePromotionRules", () => {
  it("says nothing when nothing is configured", () => {
    expect(describePromotionRules(rules(), "en")).toEqual([]);
  });

  it("summarises the structured rules and leaves the free text alone", () => {
    const out = describePromotionRules(
      rules({ weekdays: [1, 5], everyDays: 14, linksAllowed: false, notes: "Friday thread only" }),
      "en",
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toBe("Once every 14 days");
    expect(out[2]).toBe("No links");
    // The note is hers to read in full, never truncated into a chip.
    expect(out.join(" ")).not.toContain("Friday thread");
  });

  it("speaks the teacher's language", () => {
    expect(describePromotionRules(rules({ everyDays: 1 }), "es-MX")).toEqual(["Una vez al día"]);
    expect(describePromotionRules(rules({ linksAllowed: true }), "fr")).toEqual([
      "Liens autorisés",
    ]);
  });
});

describe("weekdayLabels", () => {
  it("starts on Sunday, matching the stored weekday numbering", () => {
    const en = weekdayLabels("en", "long");
    expect(en[0]).toBe("Sunday");
    expect(en[6]).toBe("Saturday");
  });

  it("localises without needing a catalog entry per day", () => {
    expect(weekdayLabels("fr", "long")[1].toLowerCase()).toBe("lundi");
  });
});

describe("hasPromotionRules", () => {
  it("is false for the default and true for anything she has set", () => {
    expect(hasPromotionRules(rules())).toBe(false);
    expect(hasPromotionRules(rules({ weekdays: [2] }))).toBe(true);
    expect(hasPromotionRules(rules({ everyDays: 7 }))).toBe(true);
    expect(hasPromotionRules(rules({ linksAllowed: false }))).toBe(true);
    expect(hasPromotionRules(rules({ notes: "  " }))).toBe(false);
    expect(hasPromotionRules(rules({ notes: "Friday only" }))).toBe(true);
  });
});
