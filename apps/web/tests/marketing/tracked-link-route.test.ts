import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// /g/<code> is an UNAUTHENTICATED path segment reachable by anyone with the
// link — including anyone who guesses at one. It must never 404, never leak
// whether a code exists, and never put an unbounded value into a query.

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://spiralclass.com", SESSION_SECRET: "x".repeat(32) }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { marketingActivity: { findUnique: vi.fn() } },
}));

const { prisma } = await import("@/lib/prisma");
const { GET } = await import("@/app/g/[code]/route");
const { ATTRIBUTION_COOKIE } = await import("@/lib/analytics/attribution");

function req(cookie?: string) {
  return new Request("https://spiralclass.com/g/abc234xyz9", {
    headers: cookie ? { cookie } : undefined,
  });
}

const COMMUNITY = { id: "a1b2c3d4-0000-0000-0000-000000000000", name: "Expats CDMX" };

const ACTIVITY = {
  id: "act-1",
  teacherId: "teacher-1",
  communityId: COMMUNITY.id,
  platform: "facebook_group",
  teacher: { bookingSlug: "mira", disabledAt: null },
  // The common case: a community with no social preview configured.
  community: { ...COMMUNITY, preview: null },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /g/[code]", () => {
  it("redirects to a CLEAN booking URL — no tracking parameters on show", async () => {
    vi.mocked(prisma.marketingActivity.findUnique).mockResolvedValue(ACTIVITY as never);
    const res = await GET(req(), { params: Promise.resolve({ code: "abc234xyz9" }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://spiralclass.com/b/mira");
  });

  it("tags the destination when — and only when — the community has a social preview", async () => {
    // A crawler scraping the posted /g/<code> follows this redirect and reads
    // the tags of what it lands on, so an untagged destination resolved no
    // group preview: D-123's per-community card was unreachable through the
    // very link D-125 tells teachers to post. The clean-landing property is
    // kept for every teacher who never configured one (the case above).
    vi.mocked(prisma.marketingActivity.findUnique).mockResolvedValue({
      ...ACTIVITY,
      community: { ...COMMUNITY, preview: { id: "preview-1" } },
    } as never);
    const res = await GET(req(), { params: Promise.resolve({ code: "abc234xyz9" }) });
    expect(res.headers.get("location")).toBe(
      "https://spiralclass.com/b/mira?utm_content=expats-cdmx-a1b2",
    );
  });

  it("stays clean for an activity with no community at all", async () => {
    // A referral ask isn't tied to a saved community, so there is no group tag
    // to add and nothing to resolve.
    vi.mocked(prisma.marketingActivity.findUnique).mockResolvedValue({
      ...ACTIVITY,
      communityId: null,
      community: null,
    } as never);
    const res = await GET(req(), { params: Promise.resolve({ code: "abc234xyz9" }) });
    expect(res.headers.get("location")).toBe("https://spiralclass.com/b/mira");
  });

  it("keeps first-touch attribution on the code, not on the tag it just added", async () => {
    // The cookie is written on THIS response, so the middleware sees a first
    // touch already recorded when the browser follows to the tagged URL and
    // leaves campaign=ap-<code> alone.
    vi.mocked(prisma.marketingActivity.findUnique).mockResolvedValue({
      ...ACTIVITY,
      community: { ...COMMUNITY, preview: { id: "preview-1" } },
    } as never);
    const res = await GET(req(), { params: Promise.resolve({ code: "abc234xyz9" }) });
    expect(res.headers.get("set-cookie") ?? "").toContain("campaign%3Dap-abc234xyz9");
  });

  it("stamps the first-touch attribution cookie with the activity's code", async () => {
    vi.mocked(prisma.marketingActivity.findUnique).mockResolvedValue(ACTIVITY as never);
    const res = await GET(req(), { params: Promise.resolve({ code: "abc234xyz9" }) });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(ATTRIBUTION_COOKIE);
    expect(setCookie).toContain("campaign%3Dap-abc234xyz9");
    expect(setCookie).toContain("HttpOnly");
  });

  it("does NOT overwrite an existing first-touch attribution", async () => {
    // First touch wins: a visitor won by a group two days ago keeps that credit
    // when she returns through a later link.
    vi.mocked(prisma.marketingActivity.findUnique).mockResolvedValue(ACTIVITY as never);
    const res = await GET(req(`${ATTRIBUTION_COOKIE}=source%3Dfacebook`), {
      params: Promise.resolve({ code: "abc234xyz9" }),
    });
    expect(res.headers.get("set-cookie") ?? "").not.toContain(`${ATTRIBUTION_COOKIE}=campaign`);
  });

  it("rejects a malformed code without ever touching the database", async () => {
    const res = await GET(req(), { params: Promise.resolve({ code: "../../etc/passwd" }) });
    expect(res.headers.get("location")).toBe("https://spiralclass.com/");
    expect(prisma.marketingActivity.findUnique).not.toHaveBeenCalled();
  });

  it("lands an unknown code softly on the home page, not a 404", async () => {
    // The link is already posted in a community; a dead end there is worse
    // than a soft landing, and a 404 would also confirm which codes exist.
    vi.mocked(prisma.marketingActivity.findUnique).mockResolvedValue(null as never);
    const res = await GET(req(), { params: Promise.resolve({ code: "zzzz234444" }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://spiralclass.com/");
  });

  it("refuses to route to a moderated teacher", async () => {
    vi.mocked(prisma.marketingActivity.findUnique).mockResolvedValue({
      ...ACTIVITY,
      teacher: { bookingSlug: "mira", disabledAt: new Date() },
    } as never);
    const res = await GET(req(), { params: Promise.resolve({ code: "abc234xyz9" }) });
    expect(res.headers.get("location")).toBe("https://spiralclass.com/");
  });
});
