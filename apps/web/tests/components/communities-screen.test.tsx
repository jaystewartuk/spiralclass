import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { PromotionRules } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

// The communities screen (D-125 / D-123) after the "this page is confusing"
// report and the communities overhaul. The rewrite's whole claim is READ FIRST,
// EDIT ON REQUEST — so these pin the properties that claim rests on, none of
// which the type system can:
//
//   * a community's name, place, promotion consequence and TODAY'S ANSWER are
//     readable TEXT, not values you have to notice inside input boxes;
//   * the three editors start folded, and stay mounted while folded, so folding
//     costs no function and no form state;
//   * the promotion rules are only offered where promotion is possible, and the
//     day picker always ships its presence marker — without it, clearing every
//     day is indistinguishable from a form that has no day picker;
//   * the archive is a quiet row, not a second copy of the editor.

// The server actions are only ever handed to useActionState here; importing the
// real module would drag prisma and auth into a view test.
vi.mock("@/app/actions/marketing", () => ({
  addCommunityAction: async () => undefined,
  archiveCommunityAction: async () => undefined,
  restoreCommunityAction: async () => undefined,
  updateCommunityAction: async () => undefined,
}));

const { AddCommunityPanel, ArchivedCommunityRow, CommunityCard } =
  await import("@/app/(app)/dashboard/get-students/communities/community-forms");
const { LocaleProvider } = await import("@/components/locale-provider");

const NO_RULES: PromotionRules = {
  weekdays: [],
  everyDays: null,
  linksAllowed: null,
  notes: null,
};

const ITEM = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Moms of Polanco",
  url: "https://facebook.com/groups/polanco",
  platform: "facebook_group" as const,
  promoPolicy: "unknown" as const,
  audienceNote: "expats in Oaxaca",
  rules: NO_RULES,
  memeBrief: null,
  archived: false,
};

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    React.createElement(LocaleProvider, { locale: "en", children: node }),
  );
}

describe("CommunityCard", () => {
  const html = render(
    React.createElement(CommunityCard, {
      item: ITEM,
      bookingUrl: "https://spiralclass.com/b/mira",
      window: { allowed: true } as const,
      post: React.createElement("p", null, "post-editor"),
      postSummary: React.createElement("span", null, "No post yet"),
      preview: React.createElement("p", null, "preview-editor"),
      previewSummary: React.createElement("span", null, "Standard card"),
    }),
  );

  it("states the community and what its rules allow as readable text", () => {
    expect(html).toContain("<h3");
    expect(html).toContain("Moms of Polanco");
    expect(html).toContain("Facebook group");
    expect(html).toContain("Rules unconfirmed");
    // The consequence of the policy, not just its name — this is the field the
    // planner keys off, and it used to be a bare <select> with no stated effect.
    expect(html).toContain("Helpful content only, until you tell us what this community allows.");
  });

  it("puts the tagged link on the card, with the community's own id in it", () => {
    expect(html).toContain("Link to post in this group");
    expect(html).toContain(ITEM.id);
  });

  it("folds all three editors shut but keeps their fields mounted", () => {
    // Three disclosures (post, image, settings), all collapsed.
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(3);
    expect(html).not.toContain('aria-expanded="true"');
    // Collapsed via `hidden`, not unmounted: the edit fields and both editors
    // still exist, so nothing about folding loses state or function.
    expect(html).toContain("post-editor");
    expect(html).toContain("preview-editor");
    expect(html).toContain(`${ITEM.id}-name`);
    expect(html).toContain('value="Moms of Polanco"');
  });

  it("offers no promotion rules for a community that cannot be promoted in", () => {
    // `unknown` is not a promotable policy, so there is nothing to schedule and
    // the whole block is absent rather than present-and-disabled.
    expect(html).not.toContain('name="promoWeekdays"');
    expect(html).not.toContain('name="promoRulesPresent"');
  });

  it("shows the rule specifics and today's answer when promotion is limited", () => {
    const limited = render(
      React.createElement(CommunityCard, {
        item: {
          ...ITEM,
          promoPolicy: "limited" as const,
          rules: { weekdays: [5], everyDays: 14, linksAllowed: false, notes: "Friday thread only" },
        },
        bookingUrl: "https://spiralclass.com/b/mira",
        window: { allowed: false, reason: "weekday", nextDayLabel: "Friday" } as const,
      }),
    );
    // The structured rules, summarised on the card itself.
    expect(limited).toContain("Fri");
    expect(limited).toContain("Once every 14 days");
    expect(limited).toContain("No links");
    // Today's answer, stated so she never has to open the settings to find it.
    expect(limited).toContain("Not a promotion day here. Next one: Friday.");
    // And the editable rules, with the presence marker the checkbox group needs.
    expect(limited).toContain('name="promoRulesPresent"');
    expect(limited).toContain('name="promoWeekdays"');
    expect(limited).toContain('name="promoEveryDays"');
    expect(limited).toContain('name="promoNotes"');
    expect(limited).toContain("Friday thread only");
    // Said out loud: free text is context, not something we can enforce.
    expect(limited).toContain("We can&#x27;t check it for you");
  });

  it("says when she promoted here too recently, with the date it reopens", () => {
    const blocked = render(
      React.createElement(CommunityCard, {
        item: { ...ITEM, promoPolicy: "open" as const },
        window: { allowed: false, reason: "frequency", nextDateLabel: "12 Sep 2026" } as const,
      }),
    );
    expect(blocked).toContain("You promoted here recently. Next one from 12 Sep 2026.");
  });

  it("carries the community's own image instructions into its editor", () => {
    const briefed = render(
      React.createElement(CommunityCard, {
        item: { ...ITEM, memeBrief: "Retired expats. Supermarket jokes land." },
        window: { allowed: true } as const,
      }),
    );
    expect(briefed).toContain('name="memeBrief"');
    expect(briefed).toContain("Retired expats. Supermarket jokes land.");
  });
});

describe("AddCommunityPanel", () => {
  it("is the empty state when she has no communities: open, and says why", () => {
    const html = render(React.createElement(AddCommunityPanel, { hasCommunities: false }));
    expect(html).toContain("Add the first place you can reach future students");
    expect(html).toContain('name="name"');
    // Nothing to cancel back to.
    expect(html).not.toContain("Cancel");
  });

  it("folds behind a button once she has one, so the list leads the page", () => {
    const html = render(React.createElement(AddCommunityPanel, { hasCommunities: true }));
    expect(html).not.toContain('name="name"');
    expect(html).toContain("Add a community");
  });
});

describe("ArchivedCommunityRow", () => {
  it("is a name and a way back, not a second copy of the editor", () => {
    const html = render(
      React.createElement(ArchivedCommunityRow, { item: { ...ITEM, archived: true } }),
    );
    expect(html).toContain("Moms of Polanco");
    expect(html).toContain("Restore");
    expect(html).not.toContain('name="audienceNote"');
    expect(html).not.toContain("Link to post in this group");
  });
});
