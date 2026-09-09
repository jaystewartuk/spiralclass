import { describe, expect, it } from "vitest";
import { createT } from "@spiralclass/shared";
import { TEMPLATE_NAMES } from "./templates";
import {
  DEFAULT_INBOX_FILTER,
  INBOX_CATEGORIES,
  groupInboxByDay,
  inboxCategoryFor,
  inboxHref,
  resolveInboxCursor,
  resolveInboxFilter,
} from "./inbox-view";

const t = createT("en");

describe("resolveInboxFilter", () => {
  it("accepts the known views", () => {
    expect(resolveInboxFilter("all")).toBe("all");
    expect(resolveInboxFilter("unread")).toBe("unread");
  });

  it("falls back to the default rather than throwing on junk", () => {
    expect(resolveInboxFilter(undefined)).toBe(DEFAULT_INBOX_FILTER);
    expect(resolveInboxFilter("")).toBe(DEFAULT_INBOX_FILTER);
    expect(resolveInboxFilter("archived")).toBe(DEFAULT_INBOX_FILTER);
  });

  it("takes the first value when the param repeats", () => {
    expect(resolveInboxFilter(["unread", "all"])).toBe("unread");
  });
});

describe("resolveInboxCursor", () => {
  it("passes an id through", () => {
    expect(resolveInboxCursor("clx0abc123")).toBe("clx0abc123");
  });

  it("rejects anything that is not an id", () => {
    expect(resolveInboxCursor(undefined)).toBeNull();
    expect(resolveInboxCursor("")).toBeNull();
    expect(resolveInboxCursor("   ")).toBeNull();
    // Punctuation is what a hand-edited or injected value looks like.
    expect(resolveInboxCursor("abc'--")).toBeNull();
    expect(resolveInboxCursor("a".repeat(65))).toBeNull();
  });
});

describe("inboxHref", () => {
  it("keeps the default view out of the URL", () => {
    expect(inboxHref("all")).toBe("/notifications");
    expect(inboxHref("all", null)).toBe("/notifications");
  });

  it("carries the view and the cursor", () => {
    expect(inboxHref("unread")).toBe("/notifications?show=unread");
    expect(inboxHref("unread", "abc")).toBe("/notifications?show=unread&cursor=abc");
    expect(inboxHref("all", "abc")).toBe("/notifications?cursor=abc");
  });
});

describe("inboxCategoryFor", () => {
  it("categorises every declared template", () => {
    for (const name of TEMPLATE_NAMES) {
      expect(INBOX_CATEGORIES, `${name} has no category`).toContain(inboxCategoryFor(name));
    }
  });

  it("does not dump templates into the generic bucket", () => {
    // `magic_link` is the only one that legitimately belongs there — it is
    // filtered out of the inbox before rendering and exists in the map only
    // because the map is exhaustive by type.
    const generic = TEMPLATE_NAMES.filter((n) => inboxCategoryFor(n) === "general");
    expect(generic).toEqual(["magic_link"]);
  });

  it("separates money in from money back", () => {
    expect(inboxCategoryFor("payment_received_teacher")).toBe("payment");
    expect(inboxCategoryFor("refund_issued_teacher")).toBe("refund");
    expect(inboxCategoryFor("payment_failed_student")).toBe("refund");
  });

  it("separates the account being ready from the account needing work", () => {
    expect(inboxCategoryFor("stripe_ready_teacher")).toBe("accountReady");
    expect(inboxCategoryFor("stripe_requirements_teacher")).toBe("accountAction");
    expect(inboxCategoryFor("account_disabled_teacher")).toBe("accountAction");
  });

  it("falls back for a row written by a build that knew a template this one does not", () => {
    expect(inboxCategoryFor("some_future_template")).toBe("general");
  });
});

describe("groupInboxByDay", () => {
  const tz = "America/Mexico_City";
  // 2026-09-02 18:00 UTC is 12:00 on 2026-09-02 in Mexico City (UTC-6).
  const now = new Date("2026-09-02T18:00:00.000Z");
  const at = (iso: string) => ({ createdAt: new Date(iso) });

  it("names today and yesterday, and dates everything older", () => {
    const groups = groupInboxByDay(
      [at("2026-09-02T16:00:00Z"), at("2026-09-01T16:00:00Z"), at("2026-08-20T16:00:00Z")],
      tz,
      "en",
      now,
      t,
    );
    expect(groups.map((g) => g.relative)).toEqual(["today", "yesterday", null]);
    expect(groups[0].label).toBe("Today");
    expect(groups[1].label).toBe("Yesterday");
    expect(groups[2].label).toMatch(/August/);
  });

  it("groups by the VIEWER's calendar day, not UTC's", () => {
    // 03:00 UTC on the 3rd is still 21:00 on the 2nd in Mexico City, so this
    // is "today" for her even though UTC has already rolled over.
    const groups = groupInboxByDay([at("2026-09-03T03:00:00Z")], tz, "en", now, t);
    expect(groups).toHaveLength(1);
    expect(groups[0].relative).toBe("today");
  });

  it("keeps the query's order and puts every row in exactly one group", () => {
    const rows = [
      at("2026-09-02T17:00:00Z"),
      at("2026-09-02T15:00:00Z"),
      at("2026-09-01T15:00:00Z"),
      at("2026-09-02T14:00:00Z"),
    ];
    const groups = groupInboxByDay(rows, tz, "en", now, t);
    // The stray fourth row rejoins the group it belongs to rather than opening
    // a second "Today".
    expect(groups.map((g) => g.items.length)).toEqual([3, 1]);
    expect(groups.flatMap((g) => g.items)).toHaveLength(rows.length);
  });

  it("returns nothing for an empty list", () => {
    expect(groupInboxByDay([], tz, "en", now, t)).toEqual([]);
  });
});
