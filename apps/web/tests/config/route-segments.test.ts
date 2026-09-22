import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every literal URL segment the app serves is English, and stays English.
 *
 * The product ships three UI locales and `DEFAULT_LOCALE` is "en", but a URL
 * has no locale to switch on: whatever word is in the path is the word every
 * teacher, student and visitor reads, in every language. So the path is
 * written in one language, and that language is English.
 *
 * It is an allowlist and not a denylist of non-English words on purpose. A
 * denylist only ever knows the mistakes already made, so it stays silent on
 * the next word until somebody has already shipped it and come back to add it.
 * The allowlist fails on any word it has not seen, which is the point — a new
 * route costs one line here, and that line is where the language of the URL
 * gets decided, out loud, while the route is being written rather than years
 * later from a bug report.
 */

const APP_DIR = resolve(__dirname, "../../src/app");

/** Files whose directory is addressable as a URL. */
const ROUTE_FILES = new Set(["page.tsx", "page.ts", "route.ts", "route.tsx"]);

/**
 * Literal path segments of every route that resolves to a URL.
 *
 * Route groups — `(app)`, `(auth)` — organise files without contributing a
 * segment, and `[param]` segments are filled from data rather than written by
 * hand, so neither is a word anybody chose.
 */
function urlSegments(dir = APP_DIR, trail: string[] = []): Set<string> {
  const out = new Set<string>();
  let hasRouteFile = false;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      const isGroup = entry.startsWith("(") && entry.endsWith(")");
      const isParam = entry.startsWith("[");
      const next = isGroup || isParam ? trail : [...trail, entry];
      for (const seg of urlSegments(full, next)) out.add(seg);
    } else if (ROUTE_FILES.has(entry)) {
      hasRouteFile = true;
    }
  }
  // Only segments that actually lead somewhere: `src/app/actions/` holds
  // server actions, not routes, and is part of no URL.
  if (hasRouteFile) for (const seg of trail) out.add(seg);
  return out;
}

/** Reviewed, English, sorted. One line per word the URL bar can show. */
const ALLOWED_SEGMENTS: readonly string[] = [
  "about",
  "account",
  "admin",
  "api",
  "audit",
  "auth",
  "availability",
  "b",
  "billing",
  "billing-webhook",
  "blocked-dates",
  "book",
  "booking-page",
  "booking-slug",
  "buy",
  "calendar",
  "call",
  "callback",
  "captions",
  "chat",
  "class-content-templates",
  "classes",
  "commission",
  "communities",
  "complete",
  "completed",
  "confirmation",
  "connect",
  "content",
  "costs",
  "csp-report",
  "customize",
  "dashboard",
  "database",
  "demo",
  "design",
  "disconnect",
  "discounts",
  "disputes",
  "economics",
  "edit",
  "email-uns",
  "end",
  "export",
  "features",
  "feed",
  "file",
  "filters",
  "focus-tags",
  "g",
  "generate",
  "get-students",
  "google",
  "health",
  "help",
  "homework",
  "i",
  "image",
  "images",
  "inngest",
  "integrations",
  "internal",
  "invitations",
  "leads",
  "lesson-insights",
  "library",
  "live",
  "live-calls",
  "livekit",
  "login",
  "m",
  "maintenance",
  "materials",
  "messages",
  "ml",
  "money",
  "my-classes",
  "new",
  "notif-settings",
  "notifications",
  "og",
  "onboarding",
  "opened",
  "packages",
  "participants",
  "payments",
  "pdf",
  "preview",
  "pricing",
  "privacy-notice",
  "profile",
  "progress",
  "r",
  "re",
  "reactions",
  "reading",
  "referrals",
  "replay",
  "reschedule",
  "resend",
  "result",
  "results",
  "return",
  "room-config",
  "search",
  "security",
  "settings",
  "share-groups",
  "sign-in",
  "sign-up",
  "social-preview",
  "staff",
  "start",
  "storage",
  "stream",
  "stripe",
  "student",
  "students",
  "subscription",
  "subscriptions",
  "teacher",
  "teachers",
  "templates",
  "terms",
  "testimonials",
  "threads",
  "timezone",
  "transfer",
  "uat",
  "video",
  "voice",
  "web-push",
  "webhook",
  "wise",
];

describe("URL route segments", () => {
  const onDisk = [...urlSegments()].sort();

  it("uses no word that has not been reviewed as English", () => {
    const allowed = new Set(ALLOWED_SEGMENTS);
    const unreviewed = onDisk.filter((seg) => !allowed.has(seg));
    expect(
      unreviewed,
      `These URL segments are not in the reviewed list in this file:\n` +
        `${unreviewed.join("\n")}\n\n` +
        `A URL cannot be translated, so every segment is English. If these are ` +
        `English, add them to ALLOWED_SEGMENTS. If they are not, rename the ` +
        `directory.`,
    ).toEqual([]);
  });

  it("has no reviewed segment that no longer exists", () => {
    const live = new Set(onDisk);
    const stale = ALLOWED_SEGMENTS.filter((seg) => !live.has(seg));
    expect(
      stale,
      `These segments are allowed but no route uses them — delete the lines:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the list sorted, so a new entry lands in one obvious place", () => {
    expect([...ALLOWED_SEGMENTS].sort()).toEqual([...ALLOWED_SEGMENTS]);
  });
});
