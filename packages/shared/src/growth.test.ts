import { describe, expect, it } from "vitest";
import {
  type GrowthSignals,
  growthAllDoneLabel,
  growthProgressLabel,
  growthSteps,
  growthSubtitle,
  growthTitle,
  shareChannelLabel,
  shareGroupSlug,
  shareTaggedUrl,
  shareText,
} from "./growth";

const EMPTY: GrowthSignals = {
  hasPhoto: false,
  hasBio: false,
  testimonialCount: 0,
  hasStudents: false,
  newLeadCount: 0,
  hasPayoutMethod: false,
};

const ALL: GrowthSignals = {
  hasPhoto: true,
  hasBio: true,
  testimonialCount: 3,
  hasStudents: true,
  newLeadCount: 0,
  hasPayoutMethod: true,
};

describe("growthSteps", () => {
  it("returns the five shipped steps in ROI order, payment first", () => {
    const { steps } = growthSteps(EMPTY, "es-MX");
    expect(steps.map((s) => s.key)).toEqual([
      "payment",
      "profile",
      "testimonials",
      "share",
      "leads",
    ]);
  });

  it("payment is done only once a payout rail is connected", () => {
    const notConnected = growthSteps(EMPTY, "en").steps.find((s) => s.key === "payment")!;
    expect(notConnected.done).toBe(false);
    const connected = growthSteps({ ...EMPTY, hasPayoutMethod: true }, "en").steps.find(
      (s) => s.key === "payment",
    )!;
    expect(connected.done).toBe(true);
    expect(connected.action).toEqual({ kind: "nav", nav: "paymentMethods" });
  });

  // Country-gated Stripe copy (reuses the settings/payments/page.tsx pattern,
  // D-58): a teacher outside SUPPORTED_CONNECT_COUNTRIES shouldn't be told to
  // "Connect Stripe" only to hit the country-unsupported wall on settings.
  it("mentions Stripe by default when stripeAvailable is omitted", () => {
    const step = growthSteps(EMPTY, "en").steps.find((s) => s.key === "payment")!;
    expect(step.body).toContain("Stripe");
  });

  it("drops Stripe from the copy and offers Wise only when stripeAvailable is false", () => {
    const en = growthSteps({ ...EMPTY, stripeAvailable: false }, "en").steps.find(
      (s) => s.key === "payment",
    )!;
    expect(en.body).not.toContain("Stripe");
    expect(en.body).toBe("Connect Wise. Without this you can't get paid for your classes.");

    const esMX = growthSteps({ ...EMPTY, stripeAvailable: false }, "es-MX").steps.find(
      (s) => s.key === "payment",
    )!;
    expect(esMX.body).not.toContain("Stripe");
    expect(esMX.body).toBe("Conecta Wise. Sin esto, no puedes cobrar tus clases.");
  });

  it("leaves the done copy unaffected by stripeAvailable — it never mentioned Stripe either way", () => {
    const step = growthSteps(
      { ...EMPTY, hasPayoutMethod: true, stripeAvailable: false },
      "en",
    ).steps.find((s) => s.key === "payment")!;
    expect(step.done).toBe(true);
    expect(step.body).toBe("You're set up to get paid for your classes.");
  });

  it("never references an unbuilt feature (no referral/taster steps)", () => {
    const keys = growthSteps(EMPTY, "en").steps.map((s) => s.key);
    expect(keys).not.toContain("referral");
    expect(keys).not.toContain("taster");
  });

  it("a brand-new teacher has only the trivially-done leads step complete", () => {
    const c = growthSteps(EMPTY, "es-MX");
    expect(c.doneCount).toBe(1); // leads (inbox zero) is the only one done
    expect(c.complete).toBe(false);
    const leads = c.steps.find((s) => s.key === "leads")!;
    expect(leads.done).toBe(true);
  });

  it("profile is done only when both photo and bio are present", () => {
    const photoOnly = growthSteps({ ...EMPTY, hasPhoto: true }, "en");
    expect(photoOnly.steps.find((s) => s.key === "profile")!.done).toBe(false);
    const both = growthSteps({ ...EMPTY, hasPhoto: true, hasBio: true }, "en");
    expect(both.steps.find((s) => s.key === "profile")!.done).toBe(true);
  });

  it("testimonials done at >= 1 and shows a correctly-pluralised count", () => {
    const one = growthSteps({ ...EMPTY, testimonialCount: 1 }, "en");
    const oneStep = one.steps.find((s) => s.key === "testimonials")!;
    expect(oneStep.done).toBe(true);
    expect(oneStep.body).toContain("1 testimonial ");
    expect(oneStep.body).not.toContain("testimonials");

    const many = growthSteps({ ...EMPTY, testimonialCount: 3 }, "en");
    expect(many.steps.find((s) => s.key === "testimonials")!.body).toContain("3 testimonials");
  });

  it("pluralises Spanish testimonial copy too", () => {
    const one = growthSteps({ ...EMPTY, testimonialCount: 1 }, "es-MX");
    expect(one.steps.find((s) => s.key === "testimonials")!.body).toContain("1 reseña ");
    const many = growthSteps({ ...EMPTY, testimonialCount: 2 }, "es-MX");
    expect(many.steps.find((s) => s.key === "testimonials")!.body).toContain("2 reseñas");
  });

  it("share done is driven by having students, and offers WhatsApp + Facebook channels", () => {
    const share = growthSteps(EMPTY, "en").steps.find((s) => s.key === "share")!;
    expect(share.done).toBe(false);
    expect(share.action).toEqual({ kind: "share", channels: ["whatsapp", "facebook"] });
    const withStudents = growthSteps({ ...EMPTY, hasStudents: true }, "en");
    expect(withStudents.steps.find((s) => s.key === "share")!.done).toBe(true);
  });

  it("surfaces a pending-lead count and pluralised body when leads await a reply", () => {
    const c = growthSteps({ ...EMPTY, newLeadCount: 2 }, "en");
    const leads = c.steps.find((s) => s.key === "leads")!;
    expect(leads.done).toBe(false);
    expect(leads.count).toBe(2);
    expect(leads.body).toContain("2 unanswered messages");

    const one = growthSteps({ ...EMPTY, newLeadCount: 1 }, "en");
    const oneLeads = one.steps.find((s) => s.key === "leads")!;
    expect(oneLeads.body).toContain("1 unanswered message");
    expect(oneLeads.body).not.toContain("messages");
  });

  it("omits the count when no leads are pending", () => {
    const leads = growthSteps(EMPTY, "en").steps.find((s) => s.key === "leads")!;
    expect(leads.count).toBeUndefined();
  });

  it("nav steps carry the NavKey of the feature that executes them", () => {
    const steps = growthSteps(EMPTY, "en").steps;
    expect(steps.find((s) => s.key === "profile")!.action).toEqual({
      kind: "nav",
      nav: "bookingPage",
    });
    expect(steps.find((s) => s.key === "testimonials")!.action).toEqual({
      kind: "nav",
      nav: "testimonials",
    });
    expect(steps.find((s) => s.key === "leads")!.action).toEqual({ kind: "nav", nav: "leads" });
  });

  it("reports completion when every step is satisfied", () => {
    const c = growthSteps(ALL, "es-MX");
    expect(c.doneCount).toBe(5);
    expect(c.total).toBe(5);
    expect(c.complete).toBe(true);
    expect(c.percent).toBe(100);
  });

  it("computes a rounded aggregate percentage", () => {
    // leads trivially done + payment connected = 2 of 5 = 40%
    const c = growthSteps({ ...EMPTY, hasPayoutMethod: true }, "en");
    expect(c.doneCount).toBe(2);
    expect(c.percent).toBe(40);
  });

  it("resolves every string for both locales (no leftover placeholders)", () => {
    for (const locale of ["es-MX", "en"] as const) {
      for (const s of growthSteps({ ...EMPTY, testimonialCount: 2, newLeadCount: 2 }, locale)
        .steps) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.body.length).toBeGreaterThan(0);
        expect(s.ctaLabel.length).toBeGreaterThan(0);
        expect(s.body).not.toContain("{n}");
        expect(s.body).not.toContain("{s}");
      }
    }
  });
});

describe("share channels", () => {
  const URL = "https://spiralclass.com/b/mira";

  it("tags the booking URL with per-channel UTM params for attribution", () => {
    expect(shareTaggedUrl(URL, "whatsapp")).toBe(
      `${URL}?utm_source=whatsapp&utm_medium=share&utm_campaign=teacher_share`,
    );
    expect(shareTaggedUrl(URL, "facebook")).toBe(
      `${URL}?utm_source=facebook&utm_medium=group&utm_campaign=teacher_share`,
    );
  });

  it("appends with & when the booking URL already has a query string", () => {
    expect(shareTaggedUrl(`${URL}?x=1`, "facebook")).toContain("?x=1&utm_source=facebook");
  });

  // Per-group tagging. utm_content is the ONLY field that distinguishes two
  // Facebook groups: the referrer is always just l.facebook.com, and fbclid is
  // per-click. Generated rather than hand-typed because a typo doesn't fail —
  // it silently splits one group into two rows in the breakdown.
  describe("per-group tagging", () => {
    const GROUP = { id: "a1b2c3d4-0000-0000-0000-000000000000", name: "Expats CDMX" };

    it("adds a utm_content derived from the group", () => {
      expect(shareTaggedUrl(URL, "facebook", GROUP)).toBe(
        `${URL}?utm_source=facebook&utm_medium=group&utm_campaign=teacher_share` +
          `&utm_content=expats-cdmx-a1b2`,
      );
    });

    it("omits utm_content entirely when no group is given", () => {
      // A generic "share on Facebook" button can only honestly claim the
      // channel — inventing a group tag there would fabricate attribution.
      expect(shareTaggedUrl(URL, "facebook")).not.toContain("utm_content");
    });

    it("strips accents rather than dropping the letter", () => {
      // Spanish group names are the common case; "Español" must not tag as
      // "espa-ol".
      expect(
        shareGroupSlug({ id: "ffff1111-0000-0000-0000-000000000000", name: "Español CDMX" }),
      ).toBe("espanol-cdmx-ffff");
    });

    it("keeps same-named groups distinct", () => {
      // Two groups can genuinely share a name. Without the id suffix they'd
      // merge into one channel and the teacher would never know.
      const a = shareGroupSlug({ id: "aaaa1111-0000-0000-0000-000000000000", name: "Idiomas" });
      const b = shareGroupSlug({ id: "bbbb2222-0000-0000-0000-000000000000", name: "Idiomas" });
      expect(a).not.toBe(b);
    });

    it("produces a tag the server-side parser accepts unchanged", () => {
      // apps/web/src/lib/analytics/attribution.ts lowercases and strips
      // anything outside [a-z0-9._-+ ], capping at 96 chars. A tag that didn't
      // survive that round-trip would arrive mangled and never match what the
      // teacher actually shared.
      const slug = shareGroupSlug({
        id: "c3d4e5f6-0000-0000-0000-000000000000",
        name: "¡Clases de Español! (CDMX) 🇲🇽 — Grupo #1 para todos los niveles",
      });
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug.length).toBeLessThanOrEqual(96);
    });

    it("still yields a usable tag when the name slugifies to nothing", () => {
      expect(shareGroupSlug({ id: "dddd4444-0000-0000-0000-000000000000", name: "🇲🇽🎓" })).toBe(
        "group-dddd",
      );
    });

    it("carries the group tag into the ready-to-paste post", () => {
      const post = shareText(URL, "facebook", "es-MX", GROUP);
      expect(post).toContain("utm_content=expats-cdmx-a1b2");
    });
  });

  it("embeds the tagged URL inside the ready-to-share post for both channels", () => {
    for (const locale of ["es-MX", "en"] as const) {
      const wa = shareText(URL, "whatsapp", locale);
      expect(wa).toContain(shareTaggedUrl(URL, "whatsapp"));
      const fb = shareText(URL, "facebook", locale);
      expect(fb).toContain(shareTaggedUrl(URL, "facebook"));
      // Facebook post is fuller than the WhatsApp one-liner (group-appropriate).
      expect(fb.length).toBeGreaterThan(wa.length);
      expect(fb).not.toContain("{url}");
    }
  });

  it("gives bilingual CTA labels per channel", () => {
    expect(shareChannelLabel("whatsapp", "es-MX")).toBe("Compartir por WhatsApp");
    expect(shareChannelLabel("facebook", "es-MX")).toBe("Compartir en Facebook");
    expect(shareChannelLabel("whatsapp", "en")).toBe("Share on WhatsApp");
    expect(shareChannelLabel("facebook", "en")).toBe("Share on Facebook");
  });
});

describe("growth labels", () => {
  it("gives bilingual title/subtitle", () => {
    expect(growthTitle("es-MX")).toBe("Crecer");
    expect(growthTitle("en")).toBe("Grow");
    expect(growthSubtitle("es-MX").length).toBeGreaterThan(0);
    expect(growthSubtitle("en").length).toBeGreaterThan(0);
  });

  it("formats the progress label", () => {
    expect(growthProgressLabel(2, 4, "en")).toBe("2 of 4 done");
    expect(growthProgressLabel(2, 4, "es-MX")).toBe("2 de 4 listos");
  });

  it("gives an all-done line for both locales", () => {
    expect(growthAllDoneLabel("es-MX").length).toBeGreaterThan(0);
    expect(growthAllDoneLabel("en").length).toBeGreaterThan(0);
  });
});
