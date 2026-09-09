import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// One prepared action, from planned to done. The rules that matter here:
// reading is teacher-scoped, generation never leaves a half-prepared row, and
// an image failure never costs the teacher the post.

const findFirst = vi.fn();
const findMany = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const groupBy = vi.fn();
const communityFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    marketingActivity: { findFirst, findMany, update, updateMany },
    acquisitionEvent: { groupBy },
    teacherShareGroup: { findFirst: communityFindFirst },
    teacherStudent: { findFirst: vi.fn(async () => null) },
  },
}));

const socialPreviewAiEnabled = vi.fn(() => true);
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://spiralclass.com" }),
  socialPreviewAiEnabled,
}));

const generateMarketingContent = vi.fn();
vi.mock("@/lib/marketing/content", () => ({ generateMarketingContent }));

const generateSocialPreviewImage = vi.fn();
vi.mock("@/lib/social-preview/generate", () => ({ generateSocialPreviewImage }));

const buildTeacherContext = vi.fn();
vi.mock("@/lib/marketing/profile", () => ({ buildTeacherContext }));

const {
  getActivity,
  listActivities,
  markActivityDone,
  prepareActivity,
  promoPolicyFor,
  skipActivity,
  updateActivityBody,
} = await import("@/lib/marketing/activities");

const ROW = {
  id: "a1",
  kind: "tip",
  platform: "facebook_group",
  status: "planned",
  title: null,
  body: null,
  angleNote: null,
  reason: { code: "untried_community", community: "Oaxaca Expats" },
  notes: null,
  trackingCode: "abc234xyz9",
  imageId: null,
  completedAt: null,
  createdAt: new Date("2026-08-17T00:00:00Z"),
  // Generation resolves the community through the ownership-scoped accessor
  // rather than a join, so what the activity row carries is just the id — the
  // community view is where policy, structured rules and the meme brief are
  // normalised together, and generation must never see a half-normalised row.
  communityId: "c1",
  community: {
    id: "c1",
    name: "Oaxaca Expats",
    url: "https://facebook.com/groups/x",
    platform: "facebook_group",
    audienceNote: "expats",
    promoPolicy: "open",
  },
  student: null,
  image: null,
};

/** A `teacher_share_groups` row as the store selects it. */
const COMMUNITY_ROW = {
  id: "c1",
  name: "Oaxaca Expats",
  url: "https://facebook.com/groups/x",
  platform: "facebook_group",
  promoPolicy: "open",
  audienceNote: "expats",
  promoWeekdays: [],
  promoEveryDays: null,
  promoLinksAllowed: null,
  promoNotes: null,
  memeBrief: null,
  archivedAt: null,
};

const CONTEXT = {
  teacherId: "t1",
  subject: "Spanish",
  locale: "es-MX",
  capabilities: {},
  profile: {},
} as unknown as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  socialPreviewAiEnabled.mockReturnValue(true);
  findFirst.mockResolvedValue(ROW);
  findMany.mockResolvedValue([ROW]);
  groupBy.mockResolvedValue([]);
  buildTeacherContext.mockResolvedValue(CONTEXT);
  generateMarketingContent.mockResolvedValue({
    ok: true,
    content: { body: "A tip.", title: null, angleNote: "Practical.", imageIdea: "a desk" },
  });
  generateSocialPreviewImage.mockResolvedValue({ ok: true, image: { id: "img-1" } });
  communityFindFirst.mockResolvedValue(COMMUNITY_ROW);
  updateMany.mockResolvedValue({ count: 1 });
});

describe("listActivities / getActivity", () => {
  it("scopes the read to the teacher", async () => {
    await getActivity("t1", "a1");
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: "a1", teacherId: "t1" });
  });

  it("returns null for another teacher's activity rather than throwing", async () => {
    findFirst.mockResolvedValue(null);
    expect(await getActivity("t1", "someone-elses")).toBeNull();
  });

  it("exposes the tracked link derived from the code, not a stored URL", async () => {
    const view = await getActivity("t1", "a1");
    expect(view?.trackedLink).toBe("https://spiralclass.com/g/abc234xyz9");
  });

  it("reports zero results for an activity nothing has come through yet", async () => {
    const view = await getActivity("t1", "a1");
    expect(view?.results).toEqual({ visits: 0, enquiries: 0, students: 0 });
  });

  it("attaches per-activity funnel counts from one grouped query", async () => {
    groupBy.mockResolvedValue([
      { activityId: "a1", kind: "visit", _count: { _all: 12 } },
      { activityId: "a1", kind: "enquiry", _count: { _all: 2 } },
      { activityId: "a1", kind: "purchase", _count: { _all: 1 } },
    ]);
    const [view] = await listActivities("t1");
    expect(view.results).toEqual({ visits: 12, enquiries: 2, students: 1 });
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it("degrades an unrecognised kind or platform rather than throwing", async () => {
    findFirst.mockResolvedValue({ ...ROW, kind: "growth_hack", platform: "myspace" });
    const view = await getActivity("t1", "a1");
    expect(view?.kind).toBe("tip");
    expect(view?.platform).toBe("other");
  });
});

describe("prepareActivity", () => {
  it("404s on another teacher's activity before generating anything", async () => {
    findFirst.mockResolvedValue(null);
    expect(await prepareActivity({ teacherId: "t1", activityId: "x", isPro: true })).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(generateMarketingContent).not.toHaveBeenCalled();
  });

  it("passes the community's real promotion policy into generation", async () => {
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateMarketingContent.mock.calls[0][0]).toMatchObject({
      promoPolicy: "open",
      community: { name: "Oaxaca Expats", audienceNote: "expats" },
    });
  });

  it("falls back to the platform's conservative default when there is no community", async () => {
    findFirst.mockResolvedValue({ ...ROW, platform: "reddit", communityId: null, community: null });
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateMarketingContent.mock.calls[0][0].promoPolicy).toBe("prohibited");
  });

  it("supplies the tracked link only when the row has a code", async () => {
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateMarketingContent.mock.calls[0][0].link).toBe(
      "https://spiralclass.com/g/abc234xyz9",
    );
    vi.clearAllMocks();
    findFirst.mockResolvedValue({ ...ROW, trackingCode: null });
    buildTeacherContext.mockResolvedValue(CONTEXT);
    generateMarketingContent.mockResolvedValue({
      ok: true,
      content: { body: "x", title: null, angleNote: "y", imageIdea: null },
    });
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateMarketingContent.mock.calls[0][0].link).toBeNull();
  });

  it("writes nothing when generation fails, so a retry is clean", async () => {
    generateMarketingContent.mockResolvedValue({ ok: false, reason: "throttled" });
    expect(await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true })).toEqual({
      ok: false,
      reason: "throttled",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("marks the row ready and stores the generated post", async () => {
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(update.mock.calls[0][0].data).toMatchObject({
      body: "A tip.",
      angleNote: "Practical.",
      status: "ready",
      imageId: "img-1",
    });
  });

  it("still ships the post when the image fails — a post without a picture is a post", async () => {
    generateSocialPreviewImage.mockResolvedValue({ ok: false, reason: "cap" });
    const result = await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(result.ok).toBe(true);
    expect(update.mock.calls[0][0].data.imageId).toBeNull();
  });

  it("survives the image rail throwing outright", async () => {
    generateSocialPreviewImage.mockRejectedValue(new Error("provider down"));
    expect((await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true })).ok).toBe(
      true,
    );
  });

  it("generates no image at all for a kind that does not want one", async () => {
    findFirst.mockResolvedValue({ ...ROW, kind: "mini_lesson" });
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateSocialPreviewImage).not.toHaveBeenCalled();
  });

  it("skips image generation entirely when the feature flag is off", async () => {
    socialPreviewAiEnabled.mockReturnValue(false);
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateSocialPreviewImage).not.toHaveBeenCalled();
  });

  it("writes the post in Spanish for a Spanish-locale teacher", async () => {
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateMarketingContent.mock.calls[0][0].outputLanguage).toBe("Spanish");
    vi.clearAllMocks();
    findFirst.mockResolvedValue(ROW);
    buildTeacherContext.mockResolvedValue({ ...CONTEXT, locale: "en" });
    generateMarketingContent.mockResolvedValue({
      ok: true,
      content: { body: "x", title: null, angleNote: "y", imageIdea: null },
    });
    generateSocialPreviewImage.mockResolvedValue({ ok: true, image: { id: "i" } });
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateMarketingContent.mock.calls[0][0].outputLanguage).toBe("English");
  });
});

describe("promoPolicyFor", () => {
  it("returns the community's recorded policy", async () => {
    communityFindFirst.mockResolvedValue({ ...COMMUNITY_ROW, promoPolicy: "limited" });
    expect(await promoPolicyFor("t1", "c1", "facebook_group")).toBe("limited");
  });

  it("returns `unknown` for a community that isn't the teacher's", async () => {
    // A NAMED community we cannot see is not the same as no community: the safe
    // reading of "I asked and got nothing back" is the strictest one, not the
    // platform default — which for WhatsApp or Instagram would be `open`.
    communityFindFirst.mockResolvedValue(null);
    expect(await promoPolicyFor("t1", "c-other", "facebook_group")).toBe("unknown");
    expect(await promoPolicyFor("t1", "c-other", "whatsapp")).toBe("unknown");
  });

  it("returns the platform default when there is no community", async () => {
    expect(await promoPolicyFor("t1", null, "reddit")).toBe("prohibited");
    expect(await promoPolicyFor("t1", null, "facebook_group")).toBe("limited");
  });
});

describe("teacher actions", () => {
  it("scopes done/skip/edit by teacher id", async () => {
    await markActivityDone("t1", "a1");
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: "a1", teacherId: "t1" });
    expect(updateMany.mock.calls[0][0].data.status).toBe("done");
    expect(updateMany.mock.calls[0][0].data.completedAt).toBeInstanceOf(Date);

    await skipActivity("t1", "a1");
    expect(updateMany.mock.calls[1][0].data).toEqual({ status: "skipped" });

    await updateActivityBody("t1", "a1", "her own words");
    expect(updateMany.mock.calls[2][0].data).toEqual({ body: "her own words" });
  });

  it("reports false when nothing matched, rather than pretending it worked", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect(await markActivityDone("t1", "x")).toBe(false);
    expect(await skipActivity("t1", "x")).toBe(false);
    expect(await updateActivityBody("t1", "x", "y")).toBe(false);
  });

  it("bounds an edited body", async () => {
    await updateActivityBody("t1", "a1", "z".repeat(9000));
    expect((updateMany.mock.calls[0][0].data.body as string).length).toBe(5000);
  });
});

describe("prepareActivity — the community's own rules ride into generation", () => {
  it("hands the writer the structured rules and her free-text note", async () => {
    communityFindFirst.mockResolvedValue({
      ...COMMUNITY_ROW,
      promoWeekdays: [5],
      promoEveryDays: 14,
      promoNotes: "Friday thread only",
    });
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateMarketingContent.mock.calls[0][0].community).toMatchObject({
      name: "Oaxaca Expats",
      rules: { weekdays: [5], everyDays: 14, notes: "Friday thread only" },
    });
  });

  it("briefs the image with the community, so its own instructions reach it", async () => {
    await prepareActivity({ teacherId: "t1", activityId: "a1", isPro: true });
    expect(generateSocialPreviewImage.mock.calls[0][0]).toMatchObject({ communityId: "c1" });
  });
});

describe("getOrCreateCommunityDraft", () => {
  it("refuses a community that is not the teacher's, before creating anything", async () => {
    const { getOrCreateCommunityDraft } = await import("@/lib/marketing/activities");
    communityFindFirst.mockResolvedValue(null);
    const result = await getOrCreateCommunityDraft({
      teacherId: "t1",
      communityId: "someone-elses",
      kind: "tip",
      platform: "facebook_group",
    });
    expect(result).toBeNull();
    expect(communityFindFirst.mock.calls[0][0].where).toMatchObject({
      id: "someone-elses",
      teacherId: "t1",
    });
  });

  it("reuses the community's one live draft rather than piling up rows", async () => {
    const { getOrCreateCommunityDraft } = await import("@/lib/marketing/activities");
    findFirst.mockResolvedValue({ id: "a1", kind: "tip", trackingCode: "abc234xyz9" });
    const result = await getOrCreateCommunityDraft({
      teacherId: "t1",
      communityId: "c1",
      kind: "tip",
      platform: "facebook_group",
    });
    expect(result).toEqual({ activityId: "a1" });
    expect(update).not.toHaveBeenCalled();
    // Only planned/ready rows count: a post she already marked done is live in
    // a feed and must never be overwritten.
    expect(findFirst.mock.calls.at(-1)?.[0].where.status).toEqual({ in: ["planned", "ready"] });
  });

  it("drops the tracked link when she switches to a kind that carries none", async () => {
    const { getOrCreateCommunityDraft } = await import("@/lib/marketing/activities");
    findFirst.mockResolvedValue({ id: "a1", kind: "intro", trackingCode: "abc234xyz9" });
    await getOrCreateCommunityDraft({
      teacherId: "t1",
      communityId: "c1",
      // A community reply never carries a link, by policy.
      kind: "community_reply",
      platform: "facebook_group",
    });
    expect(update.mock.calls[0][0].data).toMatchObject({
      kind: "community_reply",
      trackingCode: null,
    });
  });

  it("keeps an existing code when the new kind still wants one", async () => {
    const { getOrCreateCommunityDraft } = await import("@/lib/marketing/activities");
    findFirst.mockResolvedValue({ id: "a1", kind: "tip", trackingCode: "abc234xyz9" });
    await getOrCreateCommunityDraft({
      teacherId: "t1",
      communityId: "c1",
      kind: "intro",
      platform: "facebook_group",
    });
    // It may already be pasted somewhere; re-minting would orphan its visits.
    expect(update.mock.calls[0][0].data.trackingCode).toBeUndefined();
  });

  it("mints no code for a community whose rules forbid links", async () => {
    const { getOrCreateCommunityDraft } = await import("@/lib/marketing/activities");
    communityFindFirst.mockResolvedValue({ ...COMMUNITY_ROW, promoLinksAllowed: false });
    findFirst.mockResolvedValue({ id: "a1", kind: "tip", trackingCode: null });
    await getOrCreateCommunityDraft({
      teacherId: "t1",
      communityId: "c1",
      kind: "intro",
      platform: "facebook_group",
    });
    expect(update.mock.calls[0][0].data.trackingCode).toBeNull();
  });
});
