// Traffic classification for the acquisition ledger.
//
// The visit count on "Consigue alumnos" is the denominator under every
// conversion rate a teacher reads, so an inflated one does not merely look
// wrong — it makes a working page look broken and a dead channel look alive.
//
// Measured on 2026-08-28 over /b/alicia-moreno's previous 30 days: 765
// server-rendered requests, 301 ledger visits after the 12h dedup, and 79
// client-side `$pageview`s from 28 people. Nine requests in ten never ran a
// line of JavaScript. Worse, the dedup that was supposed to absorb them cannot:
// it keys on the `ap_vid` cookie, and a crawler sends none, so every crawler
// hit lands as a fresh visit while a returning human is correctly collapsed.
//
// PostHog cannot answer this for us, and its numbers say it can. `$virt_is_bot`
// reads true on 100% of `booking_page_viewed` — not because every visitor is a
// crawler, but because that event ships from posthog-node with no visitor user
// agent attached, so PostHog is classifying our own server. Any conclusion
// drawn from that property is about the sender, not the caller. The check has
// to happen here, on the request, while the header is still in hand.
//
// The user agent is read and discarded — never stored. D-125 keeps IP, user
// agent and referrer path out of `acquisition_events` deliberately, and
// filtering on a header at request time does not put it in a column.
//
// Deliberately biased toward over-matching: a false positive costs one
// uncounted visit, while a false negative inflates the number a teacher makes
// decisions on, which is the whole failure this exists to stop. The one place
// that bias is reversed is in-app browsers — see HUMAN_IN_APP_BROWSERS.

/**
 * In-app browser markers, checked FIRST and never treated as bots.
 *
 * These are real people, and for a teacher who promotes in Facebook groups and
 * WhatsApp they are disproportionately her actual buyers — someone who tapped
 * her link inside the app rather than a desktop browser. Every one of these
 * carries its platform's name in the user agent, so a naive "contains facebook"
 * or "contains tiktok" rule would silently discard exactly the traffic the
 * acquisition feature exists to measure.
 */
const HUMAN_IN_APP_BROWSERS = [
  "fban", // Facebook iOS app
  "fbav", // Facebook app (version token)
  "fb_iab", // Facebook in-app browser, Android
  "instagram",
  "musical_ly", // TikTok
  "bytedancewebview", // TikTok
  "snapchat",
  "micromessenger", // WeChat
  "gsa/", // Google app
];

/**
 * Agents that announce themselves without the word "bot", which the generic
 * pattern below would otherwise miss entirely. The link-preview fetchers come
 * first because they are what a link posted into a Facebook or WhatsApp group
 * actually summons — often several per share, none of them a reader.
 */
const NAMED_AGENTS = [
  // Link-preview and social unfurlers
  "facebookexternalhit",
  "meta-externalagent",
  "embedly",
  "iframely",
  "quora link preview",
  "skypeuripreview",
  "vkshare",
  "outbrain",
  "nuzzel",
  // Search and SEO
  "slurp", // Yahoo
  "duckduckgo",
  "baiduspider",
  "yandex",
  "sogou",
  "seznam",
  "applebot",
  "ahrefs",
  "semrush",
  "mj12",
  "dataforseo",
  "screaming frog",
  "petal", // Huawei
  // AI crawlers, retrievers and assistants
  "gptbot",
  "chatgpt",
  "oai-searchbot",
  "claude",
  "anthropic",
  "perplexity",
  "bytespider",
  "ccbot",
  "google-extended",
  "cohere",
  "diffbot",
  "amazonbot",
  "omgili",
  "timpibot",
  // Scripts, HTTP libraries and shells
  "curl",
  "wget",
  "python-requests",
  "python-urllib",
  "aiohttp",
  "httpx",
  "go-http-client",
  "okhttp",
  "java/",
  "axios",
  "node-fetch",
  "libwww-perl",
  "guzzle",
  "postman",
  "insomnia",
  "restsharp",
  // Headless browsers and automation
  "headlesschrome",
  "phantomjs",
  "puppeteer",
  "playwright",
  "selenium",
  "cypress",
  // Uptime, performance and security scanners
  "pingdom",
  "uptimerobot",
  "statuscake",
  "betteruptime",
  "checkly",
  "lighthouse",
  "pagespeed",
  "gtmetrix",
  "datadog",
  "newrelic",
  "site24x7",
  "zgrab",
  "masscan",
  "censys",
  "internet-measurement",
  "expanse",
];

/**
 * Messaging apps that both fetch link previews AND ship an in-app browser under
 * the same name. The preview fetcher sends a bare `WhatsApp/2.x`-style agent;
 * the in-app browser sends a full browser agent that happens to mention the app.
 * Only the former is a bot, so these match a bot only when nothing about the
 * agent looks like a browser.
 */
const BOT_UNLESS_BROWSER = ["whatsapp", "viber", "line/", "skype"];

/**
 * Generic tokens covering the long tail — every crawler that names itself
 * `SomethingBot` without appearing in the curated list above, including ones
 * that do not exist yet.
 */
const GENERIC_BOT_PATTERN = /bot|crawl|spider|scrape/;

/**
 * Substrings that contain a generic bot token but belong to real hardware.
 * Cubot is an Android phone brand, so `CUBOT X30` ends in a literal "bot" and
 * would otherwise cost a genuine visitor their visit.
 */
const GENERIC_FALSE_POSITIVES = ["cubot"];

/** Whether anything in the agent presents as a real rendering engine. */
function looksLikeBrowser(ua: string): boolean {
  return ua.includes("mozilla/") || ua.includes("applewebkit") || ua.includes("gecko/");
}

/**
 * Whether a request's user agent belongs to a crawler, preview fetcher, script
 * or scanner rather than a person.
 *
 * An absent or empty agent counts as a bot: every real browser sends one, and
 * the scrapers that send none are the reason this check exists.
 */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  const ua = userAgent.toLowerCase().trim();
  if (!ua) return true;

  // Humans in in-app browsers win over every rule below.
  if (HUMAN_IN_APP_BROWSERS.some((marker) => ua.includes(marker))) return false;

  if (NAMED_AGENTS.some((agent) => ua.includes(agent))) return true;

  if (!looksLikeBrowser(ua) && BOT_UNLESS_BROWSER.some((agent) => ua.includes(agent))) return true;

  if (GENERIC_FALSE_POSITIVES.some((exception) => ua.includes(exception))) return false;
  return GENERIC_BOT_PATTERN.test(ua);
}

/**
 * Whether the request currently being served is a bot.
 *
 * Read during the render, never inside `after()` — the same discipline the
 * booking page already applies to the visitor cookie, so the decision is made
 * while the request is unambiguously in scope and only the boolean travels into
 * the deferred write. Returns false outside a request scope: a caller with no
 * request cannot be a crawler, and failing open here would silently stop
 * recording real visits.
 */
export async function currentRequestIsBot(): Promise<boolean> {
  try {
    const { headers } = await import("next/headers");
    const store = await headers();
    return isBotUserAgent(store.get("user-agent"));
  } catch {
    return false;
  }
}
