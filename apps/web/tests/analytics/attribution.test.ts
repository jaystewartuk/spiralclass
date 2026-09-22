import { describe, expect, it } from "vitest";
import {
  attributionFromRequest,
  attributionProperties,
  EMPTY_ATTRIBUTION,
  hasAttribution,
  parseAttribution,
  serializeAttribution,
} from "@/lib/analytics/attribution";

// First-touch attribution for the public booking funnel — the mechanism that
// answers "which Facebook group sent the student who bought?". Values come
// from anonymous query params, so the parsing/serialisation round-trip is a
// security surface as much as an analytics one.

const SELF = "https://spiralclass.com";

function from(query: string, referer: string | null = null) {
  return attributionFromRequest({
    searchParams: new URLSearchParams(query),
    referer,
    selfOrigin: SELF,
  });
}

describe("attributionFromRequest", () => {
  it("reads the UTM tags shareTaggedUrl actually emits", () => {
    expect(from("utm_source=facebook&utm_medium=group&utm_campaign=teacher_share")).toMatchObject({
      source: "facebook",
      medium: "group",
      campaign: "teacher_share",
    });
  });

  it("keeps utm_content, which is what distinguishes one group from another", () => {
    // The whole point of the launch: five posts in five groups are one source
    // and one campaign, and are told apart only by utm_content.
    expect(from("utm_source=facebook&utm_content=grupo-expats-cdmx").content).toBe(
      "grupo-expats-cdmx",
    );
  });

  it("keeps utm_term alongside the other UTM tags", () => {
    expect(from("utm_source=facebook&utm_term=clases-de-ingles").term).toBe("clases-de-ingles");
  });

  it("records only the referring origin, never the referring URL", () => {
    // A referrer path can carry the previous page's query string — search
    // terms, tokens, someone's session id in a badly-built link. We only need
    // to know which site sent them.
    expect(from("", "https://m.facebook.com/groups/123?token=SECRET&q=private").referrer).toBe(
      "https://m.facebook.com",
    );
  });

  it("ignores a same-origin referrer", () => {
    // Otherwise the first internal click (landing → buy) overwrites the real
    // external source with our own domain.
    expect(from("", `${SELF}/b/alicia-moreno`).referrer).toBeNull();
  });

  it("treats a malformed referrer as absent rather than throwing", () => {
    expect(from("", "not-a-url").referrer).toBeNull();
  });

  it("lowercases and length-caps values so a hostile param can't bloat a dimension", () => {
    const long = "A".repeat(500);
    const out = from(`utm_source=${long}`);
    expect(out.source).toBe("a".repeat(96));
  });

  it("strips characters that would forge a field boundary in the cookie", () => {
    // `|` and `=` are the cookie's own delimiters. If they survived, a crafted
    // utm_source could inject additional fields on parse-back.
    const out = from("utm_source=face|book=evil&utm_medium=group");
    expect(out.source).toBe("facebookevil");
    expect(serializeAttribution(out)).toBe("source=facebookevil|medium=group");
    expect(parseAttribution(serializeAttribution(out))).toMatchObject({
      source: "facebookevil",
      medium: "group",
    });
  });

  // Facebook's in-app browser routinely sends no Referer. Without this, an
  // untagged link pasted into a group post arrives indistinguishable from
  // someone typing the URL — Facebook traffic booked as direct, on the very
  // channel the launch is running.
  it("recognises a Facebook click by fbclid when there is no referrer", () => {
    const out = from("fbclid=IwAR0abc123");
    expect(out.source).toBe("facebook");
    expect(hasAttribution(out)).toBe(true);
  });

  it("never lets fbclid override an explicit utm_source", () => {
    // A tagged link is the teacher's own statement of where it was posted;
    // Facebook appends fbclid to it regardless.
    expect(from("utm_source=whatsapp&fbclid=IwAR0abc123").source).toBe("whatsapp");
  });

  // Google Ads auto-tagging appends gclid to every ad click. Paid search sets
  // its landing URL once, so an untagged one silently books the whole spend as
  // direct traffic — the ads then read as though they sent nobody.
  it("recognises a Google Ads click by gclid when there is no referrer", () => {
    const out = from("gclid=Cj0KCQjw_abc123");
    expect(out.source).toBe("google");
    expect(hasAttribution(out)).toBe(true);
  });

  it("never lets gclid override an explicit utm_source", () => {
    // A manually tagged ad URL is the operator's own statement of the channel;
    // auto-tagging appends gclid to it regardless.
    expect(from("utm_source=google-search&gclid=Cj0KCQjw_abc123").source).toBe("google-search");
  });

  it("does not invent a keyword or campaign from gclid", () => {
    // gclid is per-click and says nothing about which keyword matched. Only
    // utm_term / utm_campaign can carry that — this test exists so nobody
    // later reads `source: "google"` as if it were keyword-level attribution.
    const out = from("gclid=Cj0KCQjw_abc123");
    expect(out.term).toBeNull();
    expect(out.campaign).toBeNull();
    expect(out.content).toBeNull();
  });

  // Microsoft Ads is the network a £50 test actually runs on — cheaper clicks
  // than Google, and a spend that small is the one least able to survive being
  // reconciled as direct.
  it("recognises a Microsoft Ads click by msclkid when there is no referrer", () => {
    const out = from("msclkid=1a2b3c4d5e6f");
    expect(out.source).toBe("microsoft");
    expect(hasAttribution(out)).toBe(true);
  });

  it("never lets msclkid override an explicit utm_source", () => {
    expect(from("utm_source=bing-search&msclkid=1a2b3c4d5e6f").source).toBe("bing-search");
  });

  it("prefers fbclid over gclid when a link somehow carries both", () => {
    // Not a real Google Ads shape: it happens when an already-tagged ad link
    // is re-shared into Facebook, which appends its own id. The click that
    // produced THIS request came from Facebook, so it wins.
    expect(from("gclid=Cj0KCQjw_abc123&fbclid=IwAR0abc123").source).toBe("facebook");
  });

  it("does not invent a group from fbclid", () => {
    // fbclid is per-click and says nothing about which group the post was in.
    // Only utm_content can distinguish groups — this test exists so nobody
    // later reads `source: "facebook"` as if it were group-level attribution.
    const out = from("fbclid=IwAR0abc123");
    expect(out.content).toBeNull();
    expect(out.campaign).toBeNull();
  });

  it("yields nothing for a plain direct visit", () => {
    const out = from("");
    expect(out).toEqual(EMPTY_ATTRIBUTION);
    expect(hasAttribution(out)).toBe(false);
  });

  it("counts a bare referrer as attribution worth storing", () => {
    expect(hasAttribution(from("", "https://l.facebook.com/"))).toBe(true);
  });
});

describe("serialize/parse round-trip", () => {
  it("survives a full attribution unchanged", () => {
    const original = from(
      "utm_source=facebook&utm_medium=group&utm_campaign=teacher_share&utm_content=grupo-1&utm_term=clases-de-ingles",
      "https://l.facebook.com/",
    );
    expect(parseAttribution(serializeAttribution(original))).toEqual(original);
  });

  it("survives a partial attribution without inventing fields", () => {
    const original = from("utm_source=whatsapp");
    const round = parseAttribution(serializeAttribution(original));
    expect(round).toEqual(original);
    expect(round.medium).toBeNull();
  });

  it("ignores unknown or malformed keys in a tampered cookie", () => {
    // The cookie is httpOnly, but it still arrives from the client and must
    // never be trusted to contain only what we wrote.
    expect(parseAttribution("source=facebook|bogus=x|=novalue|medium")).toEqual({
      ...EMPTY_ATTRIBUTION,
      source: "facebook",
    });
  });

  it("treats an empty or absent cookie as no attribution", () => {
    expect(parseAttribution(undefined)).toEqual(EMPTY_ATTRIBUTION);
    expect(parseAttribution("")).toEqual(EMPTY_ATTRIBUTION);
  });
});

describe("attributionProperties", () => {
  it("prefixes properties so they can't be confused with posthog-js's own UTMs", () => {
    // posthog-js autocaptures $initial_utm_* — a different measurement (the
    // Person's first-ever touch, if they ever identify). Sharing names would
    // let the two silently shadow each other in a breakdown.
    expect(attributionProperties(from("utm_source=facebook&utm_medium=group"))).toEqual({
      attrSource: "facebook",
      attrMedium: "group",
      attrCampaign: null,
      attrContent: null,
      attrTerm: null,
      attrReferrer: null,
    });
  });

  it("emits explicit nulls so a direct visit is distinguishable from an unstamped event", () => {
    expect(attributionProperties(EMPTY_ATTRIBUTION)).toEqual({
      attrSource: null,
      attrMedium: null,
      attrCampaign: null,
      attrContent: null,
      attrTerm: null,
      attrReferrer: null,
    });
  });
});
