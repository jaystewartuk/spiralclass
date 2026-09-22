// First-touch marketing attribution for the PUBLIC booking funnel.
//
// The problem this solves: we could not answer "which Facebook group sent the
// student who bought?" — the single question the launch was posted to answer.
// Three half-wired systems existed, none of which closed the loop:
//
//   * `shareTaggedUrl` (packages/shared/src/growth.ts) GENERATES utm_source /
//     utm_medium / utm_campaign on the links a teacher shares, but nothing
//     ever read them back on the server or attached them to an event.
//   * `?ref=` → the `ap_ref` cookie (lib/subscriptions/referral.ts) attributes
//     TEACHER signups to an ambassador. It never touches students, and never
//     reaches PostHog at all.
//   * posthog-js records `$initial_utm_*` — but `person_profiles:
//     "identified_only"` means an anonymous booking-page visitor never becomes
//     a Person, so those initial properties only ever materialise if and when
//     she later signs in. By then the funnel step that mattered is long past.
//
// So: capture the source on the visitor's FIRST request in a first-party
// cookie, then stamp it onto the server-side funnel events. Server-side
// because those events are the ones that survive ad-blockers, and because the
// purchase itself is a server event — attribution has to reach that far to be
// worth collecting.
//
// FIRST-touch, not last: a visitor who arrives from a Facebook group, leaves,
// and returns two days later via a bookmark was still won by that group.
// Overwriting on the second visit would credit the bookmark and quietly
// under-report every paid or social channel.

export const ATTRIBUTION_COOKIE = "ap_src";

// 30 days, matching the ap_ref ambassador cookie. Long enough to survive the
// think-about-it gap between reading a group post and buying; short enough
// that a much later organic return isn't still credited to it.
export const ATTRIBUTION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// Values land in event properties and PostHog breakdowns, so they are capped
// and charset-limited: an unbounded query param would otherwise flow straight
// into an analytics dimension (and a cookie) from an anonymous caller.
const MAX_VALUE_LENGTH = 96;
const MAX_REFERRER_LENGTH = 200;

export type Attribution = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  referrer: string | null;
};

export const EMPTY_ATTRIBUTION: Attribution = {
  source: null,
  medium: null,
  campaign: null,
  content: null,
  term: null,
  referrer: null,
};

/** UTM params, in the order they are serialised into the cookie. */
const UTM_FIELDS = ["source", "medium", "campaign", "content", "term"] as const;

function cleanValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    // Keep the charset a campaign tag realistically needs. Notably excludes
    // the cookie delimiters below, so a crafted value can't forge extra
    // fields when the cookie is parsed back.
    .replace(/[^a-z0-9._\-+ ]/g, "")
    .slice(0, MAX_VALUE_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The referring ORIGIN only — never the full URL. A referrer path can carry
 * the previous page's query string (search terms, tokens, someone's session
 * id in a badly-built link), and we only need to know which site sent them.
 */
function cleanReferrer(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const origin = new URL(raw).origin.toLowerCase();
    return origin.slice(0, MAX_REFERRER_LENGTH);
  } catch {
    return null;
  }
}

/**
 * Click-id fallback: the platform a visit came from, when nothing else says.
 *
 * Two different blind spots, one mechanism:
 *
 *   * `fbclid` — Facebook's in-app browser routinely sends NO Referer, so an
 *     untagged link pasted into a group post arrives looking identical to
 *     someone typing the URL in, i.e. Facebook traffic recorded as direct.
 *     Facebook appends fbclid to outbound clicks itself, and in that case it
 *     is the only remaining evidence.
 *   * `gclid` — Google Ads auto-tagging appends this to every ad click. Paid
 *     search is the one channel where the landing URL is configured once and
 *     then never touched again, so a forgotten utm_source is permanent rather
 *     than a per-post slip: without this, an entire ad spend reconciles as
 *     direct traffic and reads as though the ads sent nobody.
 *   * `msclkid` — the same mechanism on Microsoft Ads (Bing), which is the
 *     cheaper network to test a small budget on and skews to exactly the
 *     older, US, desktop audience a teacher selling to expat retirees wants.
 *     A spend too small to survive being misattributed is the one that most
 *     needs this.
 *
 * These identify the PLATFORM, never the placement. Every one of these ids is
 * per-click and says nothing about which group the post was in or which
 * keyword was matched — only utm_content / utm_term can carry that. So this
 * stops a channel being undercounted; it does not substitute for tagging.
 *
 * Ordered, first match wins, and never overrides an explicit utm_source. To
 * cover another network later (`ttclid` for TikTok) add a row — the caller
 * does not change.
 */
const CLICK_ID_SOURCES: ReadonlyArray<readonly [param: string, source: string]> = [
  ["fbclid", "facebook"],
  ["gclid", "google"],
  ["msclkid", "microsoft"],
];

function clickIdPlatform(searchParams: URLSearchParams): string | null {
  for (const [param, source] of CLICK_ID_SOURCES) {
    if (searchParams.has(param)) return source;
  }
  return null;
}

/** Reads the attribution a request is arriving WITH (query params + Referer). */
export function attributionFromRequest(input: {
  searchParams: URLSearchParams;
  referer: string | null | undefined;
  selfOrigin: string;
}): Attribution {
  const referrer = cleanReferrer(input.referer);

  const explicitSource = cleanValue(input.searchParams.get("utm_source"));
  const clickIdSource = clickIdPlatform(input.searchParams);

  return {
    source: explicitSource ?? clickIdSource,
    medium: cleanValue(input.searchParams.get("utm_medium")),
    campaign: cleanValue(input.searchParams.get("utm_campaign")),
    content: cleanValue(input.searchParams.get("utm_content")),
    term: cleanValue(input.searchParams.get("utm_term")),
    // Same-origin navigation isn't a source — it's the visitor moving around
    // inside the funnel. Recording it would overwrite the real external
    // referrer with our own domain on the very next click.
    referrer: referrer && referrer !== input.selfOrigin.toLowerCase() ? referrer : null,
  };
}

/** True when there is anything worth persisting. */
export function hasAttribution(a: Attribution): boolean {
  return Object.values(a).some((v) => v !== null);
}

// Serialised as `k=v` pairs joined by `|`. Both delimiters are stripped by
// cleanValue/cleanReferrer, so no value can inject a field boundary.
const PAIR_SEPARATOR = "|";
const KV_SEPARATOR = "=";

export function serializeAttribution(a: Attribution): string {
  const parts: string[] = [];
  for (const field of UTM_FIELDS) {
    const value = a[field];
    if (value) parts.push(`${field}${KV_SEPARATOR}${value}`);
  }
  if (a.referrer) parts.push(`referrer${KV_SEPARATOR}${a.referrer}`);
  return parts.join(PAIR_SEPARATOR);
}

export function parseAttribution(raw: string | null | undefined): Attribution {
  if (!raw) return EMPTY_ATTRIBUTION;
  const out: Attribution = { ...EMPTY_ATTRIBUTION };
  for (const pair of raw.split(PAIR_SEPARATOR)) {
    const idx = pair.indexOf(KV_SEPARATOR);
    if (idx <= 0) continue;
    const key = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    if (!value) continue;
    if (key === "referrer") {
      out.referrer = value.slice(0, MAX_REFERRER_LENGTH);
    } else if ((UTM_FIELDS as readonly string[]).includes(key)) {
      out[key as (typeof UTM_FIELDS)[number]] = value.slice(0, MAX_VALUE_LENGTH);
    }
  }
  return out;
}

/**
 * The stored first-touch attribution for the current request, as written by
 * the middleware. Safe to call from any Server Component / server action /
 * route handler; returns EMPTY_ATTRIBUTION outside a request scope (tests,
 * build-time rendering) rather than throwing.
 */
export async function currentAttribution(): Promise<Attribution> {
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    return parseAttribution(store.get(ATTRIBUTION_COOKIE)?.value);
  } catch {
    return EMPTY_ATTRIBUTION;
  }
}

/**
 * Flattens attribution into PostHog event properties.
 *
 * Prefixed `attr*` rather than reusing `utm_source` etc. so these can never be
 * confused with posthog-js's own autocaptured `$initial_utm_*` — which measure
 * a different thing (the Person's first-ever touch, if they ever identify) and
 * would otherwise silently shadow each other in a breakdown.
 */
export type AttributionProperties = {
  attrSource: string | null;
  attrMedium: string | null;
  attrCampaign: string | null;
  attrContent: string | null;
  attrTerm: string | null;
  attrReferrer: string | null;
};

export function attributionProperties(a: Attribution): AttributionProperties {
  return {
    attrSource: a.source,
    attrMedium: a.medium,
    attrCampaign: a.campaign,
    attrContent: a.content,
    attrTerm: a.term,
    attrReferrer: a.referrer,
  };
}
