import { describe, expect, it } from "vitest";
import { isBotUserAgent } from "@/lib/marketing/bots";

// Real agents, copied from live traffic shapes rather than invented — a
// hand-written approximation of a user agent tests the approximation.
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0";

describe("isBotUserAgent", () => {
  it("treats ordinary browsers as human", () => {
    expect(isBotUserAgent(CHROME_MAC)).toBe(false);
    expect(isBotUserAgent(SAFARI_IOS)).toBe(false);
    expect(isBotUserAgent(CHROME_ANDROID)).toBe(false);
    expect(isBotUserAgent(FIREFOX_WINDOWS)).toBe(false);
  });

  // The teacher's buyers arrive by tapping a link inside a social app, so
  // misfiling these as crawlers would discard the exact traffic the
  // acquisition ledger exists to measure — and would do it invisibly.
  it("treats in-app browsers as human even though they name their platform", () => {
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 335.0.0.32.98",
      ),
    ).toBe(false);
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/468.0.0.34.107]",
      ),
    ).toBe(false);
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 musical_ly_2022803040 JsSdk/1.0",
      ),
    ).toBe(false);
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.90.0.42",
      ),
    ).toBe(false);
  });

  it("separates WhatsApp's preview fetcher from its in-app browser", () => {
    expect(isBotUserAgent("WhatsApp/2.23.20.0 A")).toBe(true);
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36 WhatsApp/2.24.17.79",
      ),
    ).toBe(false);
  });

  it("catches the link-preview fetchers a shared link summons", () => {
    expect(
      isBotUserAgent("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"),
    ).toBe(true);
    expect(isBotUserAgent("meta-externalagent/1.1")).toBe(true);
    expect(isBotUserAgent("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isBotUserAgent("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)")).toBe(true);
    expect(
      isBotUserAgent("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)"),
    ).toBe(true);
    expect(isBotUserAgent("LinkedInBot/1.0 (compatible; Mozilla/5.0)")).toBe(true);
    expect(isBotUserAgent("Twitterbot/1.0")).toBe(true);
  });

  it("catches search and AI crawlers", () => {
    expect(
      isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"),
    ).toBe(true);
    expect(
      isBotUserAgent("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot)"),
    ).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2)")).toBe(true);
    expect(
      isBotUserAgent("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"),
    ).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 (compatible; PerplexityBot/1.0)")).toBe(true);
    expect(
      isBotUserAgent("Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)"),
    ).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 (compatible; Applebot/0.1)")).toBe(true);
  });

  it("catches scripts, scanners and headless browsers", () => {
    expect(isBotUserAgent("curl/8.6.0")).toBe(true);
    expect(isBotUserAgent("Wget/1.21.4")).toBe(true);
    expect(isBotUserAgent("python-requests/2.31.0")).toBe(true);
    expect(isBotUserAgent("Go-http-client/2.0")).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/127.0.0.0")).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 (compatible; UptimeRobot/2.0)")).toBe(true);
  });

  // Cubot is an Android phone brand; its model names end in a literal "bot".
  it("does not mistake a phone brand for a crawler", () => {
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (Linux; Android 11; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Mobile Safari/537.36",
      ),
    ).toBe(false);
  });

  // Every real browser sends an agent. The scrapers that send none are a large
  // part of why this check exists, so silence counts against them.
  it("treats a missing or empty agent as a bot", () => {
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
    expect(isBotUserAgent("   ")).toBe(true);
  });

  it("matches regardless of case", () => {
    expect(isBotUserAgent("FACEBOOKEXTERNALHIT/1.1")).toBe(true);
    expect(isBotUserAgent("CURL/8.6.0")).toBe(true);
  });
});
