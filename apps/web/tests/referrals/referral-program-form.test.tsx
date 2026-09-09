import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { ReferralRewardDraft } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

// The teacher's referral form, rendered server-side.
//
// Three things here are worth a regression test because each was previously
// wrong and none of them shows up in a typecheck:
//
//  1. The unit picker is a radio GROUP. It used to be two <Button>s, which
//     announced as unrelated buttons with no selected state — a control that
//     looked like a choice and was not one.
//  2. Only the SELECTED unit's input is rendered, so the other name is absent
//     from the FormData rather than present-and-empty. The action's parsing
//     depends on that (see @/lib/form-data).
//  3. The cost breakdown is the reason this is a Client Component at all, and
//     it must degrade honestly: no package, or a half-filled reward, says so
//     rather than showing a confident zero.

vi.mock("@/app/actions/referrals", () => ({ saveReferralProgram: vi.fn() }));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("@/components/pricing-currency-context", () => ({
  usePricingCurrency: () => "MXN",
}));

const { ReferralProgramForm } =
  await import("@/app/(app)/dashboard/referrals/referral-program-form");

const PERCENT: ReferralRewardDraft = { kind: "percent", percent: 15, amount: null };
const FIXED: ReferralRewardDraft = { kind: "fixed", percent: null, amount: 200 };
const SAMPLE = { name: "10 classes", priceMinorUnits: 200_000, currency: "MXN" };

function render(over: Partial<React.ComponentProps<typeof ReferralProgramForm>["initial"]> = {}) {
  return renderToStaticMarkup(
    React.createElement(ReferralProgramForm, {
      initial: {
        enabled: true,
        referred: PERCENT,
        referrer: FIXED,
        rewardExpiryDays: 90,
        samplePackage: SAMPLE,
        ...over,
      },
    }),
  );
}

describe("ReferralProgramForm", () => {
  it("offers each unit as a radio in a labelled group, not as buttons", () => {
    const html = render();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('name="referredUnit"');
    expect(html).toContain('name="referrerUnit"');
    // Both sides' current unit is announced as selected.
    expect(html.match(/checked=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("submits only the selected unit's field for each side", () => {
    const html = render();
    expect(html).toContain('name="referredPercent"');
    expect(html).not.toContain('name="referredAmountPesos"');
    expect(html).toContain('name="referrerAmountPesos"');
    expect(html).not.toContain('name="referrerPercent"');
    // The kind travels alongside so the action knows which one to read.
    expect(html).toContain('name="referredKind" value="percent"');
    expect(html).toContain('name="referrerKind" value="fixed"');
  });

  it("prices the breakdown against the teacher's own package", () => {
    const html = render();
    // 15% of MX$2,000 = MX$300 off, so the friend pays MX$1,700; the referrer's
    // MX$200 makes MX$500 given away in total.
    expect(html).toContain("$1,700.00 MXN");
    expect(html).toContain("$300.00 MXN");
    expect(html).toContain("$200.00 MXN");
    expect(html).toContain("$500.00 MXN");
    expect(html).toContain("preview.expiry");
  });

  it("says the reward never expires when the field is blank", () => {
    const html = render({ rewardExpiryDays: null });
    expect(html).toContain("preview.noExpiry");
    expect(html).not.toContain("preview.expiry");
  });

  it("asks for a package rather than pricing against nothing", () => {
    const html = render({ samplePackage: null });
    expect(html).toContain("preview.noPackage");
    expect(html).not.toContain("preview.total");
  });

  it("waits for both rewards before claiming a total", () => {
    const html = render({ referrer: { kind: "fixed", percent: null, amount: null } });
    expect(html).toContain("preview.incomplete");
    expect(html).not.toContain("preview.total");
  });

  it("keeps the submit button enabled on first render", () => {
    expect(render()).not.toContain('disabled=""');
  });
});
