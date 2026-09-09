import { beforeEach, describe, expect, it, vi } from "vitest";

// The server actions. They are thin, but they own three things worth pinning:
// every entry point starts at requireOnboardedTeacher() and never accepts a
// teacherId from the client; the domain's failure vocabulary is translated into
// a message a teacher can act on (and in her language); and the two analytics
// events fire with the right shape.

const requireOnboardedTeacher = vi.fn();
const loadEntitlements = vi.fn();
const generateSocialPreviewImage = vi.fn();
const uploadSocialPreviewImage = vi.fn();
const selectSocialPreview = vi.fn();
const clearSocialPreview = vi.fn();
const deleteSocialPreviewImage = vi.fn();
const renameSocialPreviewImage = vi.fn();
const trackServerEvent = vi.fn();
const revalidatePath = vi.fn();
const getPreferredLocale = vi.fn(async () => "en");

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale }));
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent }));
vi.mock("@/lib/subscriptions/service", () => ({ loadEntitlements }));
vi.mock("@/lib/social-preview/generate", () => ({ generateSocialPreviewImage }));
vi.mock("@/lib/social-preview/upload", () => ({ uploadSocialPreviewImage }));
vi.mock("@/lib/social-preview/store", () => ({
  selectSocialPreview,
  clearSocialPreview,
  deleteSocialPreviewImage,
  renameSocialPreviewImage,
}));

const TEACHER = { id: "teacher-1", teachingLanguage: "es" };
const IMAGE = {
  id: "33333333-3333-3333-3333-333333333333",
  source: "ai" as const,
  angle: "meme" as const,
  topic: null,
  url: "https://cdn.example/x.png",
  createdAt: "2026-08-22T00:00:00Z",
};

function form(entries: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

async function actions() {
  return import("@/app/actions/social-preview");
}

beforeEach(() => {
  vi.clearAllMocks();
  getPreferredLocale.mockResolvedValue("en");
  requireOnboardedTeacher.mockResolvedValue(TEACHER);
  loadEntitlements.mockResolvedValue({ isPro: true });
});

describe("generateSocialPreview", () => {
  it("passes the teacher's own id and language — never anything from the form", async () => {
    generateSocialPreviewImage.mockResolvedValue({
      ok: true,
      image: IMAGE,
      quota: { used: 1, cap: 20 },
    });
    const { generateSocialPreview } = await actions();
    const result = await generateSocialPreview(undefined, form({ angle: "meme", topic: "cats" }));

    expect(result).toEqual({ ok: true, imageId: IMAGE.id });
    expect(generateSocialPreviewImage).toHaveBeenCalledWith({
      teacherId: "teacher-1",
      isPro: true,
      teachingLanguage: "es",
      angle: "meme",
      topic: "cats",
      // No community on this form, so the brief carries no community context.
      communityId: null,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/get-students/communities");
  });

  it("forwards the community so its own image instructions reach the brief", async () => {
    generateSocialPreviewImage.mockResolvedValue({
      ok: true,
      image: IMAGE,
      quota: { used: 1, cap: 20 },
    });
    const { generateSocialPreview } = await actions();
    await generateSocialPreview(
      undefined,
      form({ angle: "meme", communityId: "3f0c6a1e-6a2d-4f3b-9a11-2b7c0d5e8f90" }),
    );
    // Ownership of the id is re-checked in the domain, so a forged one yields
    // no community context rather than another teacher's.
    expect(generateSocialPreviewImage.mock.calls[0][0].communityId).toBe(
      "3f0c6a1e-6a2d-4f3b-9a11-2b7c0d5e8f90",
    );
  });

  it("ignores a teacherId smuggled through the form", async () => {
    generateSocialPreviewImage.mockResolvedValue({
      ok: true,
      image: IMAGE,
      quota: { used: 1, cap: 20 },
    });
    const { generateSocialPreview } = await actions();
    await generateSocialPreview(undefined, form({ angle: "meme", teacherId: "someone-else" }));
    expect(generateSocialPreviewImage.mock.calls[0][0].teacherId).toBe("teacher-1");
  });

  it("rejects an unknown angle before authenticating or spending", async () => {
    const { generateSocialPreview } = await actions();
    const result = await generateSocialPreview(undefined, form({ angle: "educational" }));
    expect(result?.error).toBeTruthy();
    expect(generateSocialPreviewImage).not.toHaveBeenCalled();
  });

  it("uses the Free cap when the teacher is not Pro", async () => {
    loadEntitlements.mockResolvedValue({ isPro: false });
    generateSocialPreviewImage.mockResolvedValue({
      ok: true,
      image: IMAGE,
      quota: { used: 1, cap: 3 },
    });
    const { generateSocialPreview } = await actions();
    await generateSocialPreview(undefined, form({ angle: "meme" }));
    expect(generateSocialPreviewImage.mock.calls[0][0].isPro).toBe(false);
  });

  it.each([
    ["cap", /used all 20/i],
    ["throttled", /too quickly/i],
    ["blocked", /describing it differently/i],
    ["timeout", /too long/i],
    ["not-configured", /upload your own/i],
    ["error", /try again/i],
  ])("translates %s into an actionable message", async (reason, matcher) => {
    generateSocialPreviewImage.mockResolvedValue({
      ok: false,
      reason,
      ...(reason === "cap" ? { quota: { used: 20, cap: 20 } } : {}),
    });
    const { generateSocialPreview } = await actions();
    const result = await generateSocialPreview(undefined, form({ angle: "meme" }));
    expect(result?.error).toMatch(matcher);
  });

  it("answers in Spanish for a Spanish-locale teacher", async () => {
    getPreferredLocale.mockResolvedValue("es-MX");
    generateSocialPreviewImage.mockResolvedValue({ ok: false, reason: "blocked" });
    const { generateSocialPreview } = await actions();
    const result = await generateSocialPreview(undefined, form({ angle: "meme" }));
    expect(result?.error).toMatch(/no pudo crear/i);
  });

  it("records the outcome either way, with the reason on failure", async () => {
    generateSocialPreviewImage.mockResolvedValue({
      ok: true,
      image: IMAGE,
      quota: { used: 1, cap: 20 },
    });
    const { generateSocialPreview } = await actions();
    await generateSocialPreview(undefined, form({ angle: "tip", topic: "the subjunctive" }));
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "social_preview_generated",
      distinctId: "teacher-1",
      properties: {
        teacherId: "teacher-1",
        angle: "tip",
        hasTopic: true,
        forCommunity: false,
        ok: true,
      },
    });

    vi.clearAllMocks();
    requireOnboardedTeacher.mockResolvedValue(TEACHER);
    loadEntitlements.mockResolvedValue({ isPro: true });
    generateSocialPreviewImage.mockResolvedValue({
      ok: false,
      reason: "cap",
      quota: { used: 20, cap: 20 },
    });
    await generateSocialPreview(undefined, form({ angle: "meme" }));
    expect(trackServerEvent.mock.calls[0][0].properties).toMatchObject({
      ok: false,
      reason: "cap",
    });
  });

  it("does not revalidate on failure", async () => {
    generateSocialPreviewImage.mockResolvedValue({ ok: false, reason: "error" });
    const { generateSocialPreview } = await actions();
    await generateSocialPreview(undefined, form({ angle: "meme" }));
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("uploadSocialPreview", () => {
  const file = () => new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

  it("uploads under the signed-in teacher", async () => {
    uploadSocialPreviewImage.mockResolvedValue({ ok: true, image: IMAGE });
    const { uploadSocialPreview } = await actions();
    const result = await uploadSocialPreview(undefined, form({ file: file() }));
    expect(result).toEqual({ ok: true, imageId: IMAGE.id });
    expect(uploadSocialPreviewImage.mock.calls[0][0].teacherId).toBe("teacher-1");
  });

  it("refuses a submission with no file", async () => {
    const { uploadSocialPreview } = await actions();
    const result = await uploadSocialPreview(undefined, form({}));
    expect(result?.error).toMatch(/choose an image/i);
    expect(uploadSocialPreviewImage).not.toHaveBeenCalled();
  });

  it.each([
    ["type", /JPG, PNG or WebP/i],
    ["too-large", /5 MB/i],
    ["empty", /empty/i],
    ["storage", /couldn't upload/i],
  ])("translates %s", async (reason, matcher) => {
    uploadSocialPreviewImage.mockResolvedValue({ ok: false, reason });
    const { uploadSocialPreview } = await actions();
    const result = await uploadSocialPreview(undefined, form({ file: file() }));
    expect(result?.error).toMatch(matcher);
  });
});

describe("useSocialPreview", () => {
  const OK = {
    ok: true as const,
    preview: { id: "p1", shareGroupId: null, caption: "hi", image: IMAGE, cardUrl: "u" },
  };

  it("treats an empty shareGroupId as the teacher's DEFAULT, not as missing input", async () => {
    selectSocialPreview.mockResolvedValue(OK);
    const { useSocialPreview } = await actions();
    const result = await useSocialPreview(
      undefined,
      form({ imageId: IMAGE.id, shareGroupId: "", caption: "hola" }),
    );
    expect(result).toEqual({ ok: true });
    expect(selectSocialPreview).toHaveBeenCalledWith({
      teacherId: "teacher-1",
      imageId: IMAGE.id,
      shareGroupId: null,
      caption: "hola",
    });
  });

  it("passes a real group through", async () => {
    selectSocialPreview.mockResolvedValue({
      ...OK,
      preview: { ...OK.preview, shareGroupId: "g1" },
    });
    const { useSocialPreview } = await actions();
    const gid = "44444444-4444-4444-4444-444444444444";
    await useSocialPreview(undefined, form({ imageId: IMAGE.id, shareGroupId: gid, caption: "" }));
    expect(selectSocialPreview.mock.calls[0][0].shareGroupId).toBe(gid);
  });

  it("gives the SAME message for not-yours and not-there, so ids can't be probed", async () => {
    const { useSocialPreview } = await actions();
    selectSocialPreview.mockResolvedValue({ ok: false, reason: "image-not-found" });
    const a = await useSocialPreview(undefined, form({ imageId: IMAGE.id, shareGroupId: "" }));
    selectSocialPreview.mockResolvedValue({ ok: false, reason: "group-not-found" });
    const b = await useSocialPreview(undefined, form({ imageId: IMAGE.id, shareGroupId: "" }));
    expect(a?.error).toBe(b?.error);
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid imageId", async () => {
    const { useSocialPreview } = await actions();
    const result = await useSocialPreview(
      undefined,
      form({ imageId: "../../etc", shareGroupId: "" }),
    );
    expect(result?.error).toBeTruthy();
    expect(selectSocialPreview).not.toHaveBeenCalled();
  });

  it("records the selection with the angle the analytics breakdown needs", async () => {
    selectSocialPreview.mockResolvedValue(OK);
    const { useSocialPreview } = await actions();
    await useSocialPreview(
      undefined,
      form({ imageId: IMAGE.id, shareGroupId: "", caption: "hola" }),
    );
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "social_preview_selected",
      distinctId: "teacher-1",
      properties: {
        teacherId: "teacher-1",
        source: "ai",
        angle: "meme",
        shareGroupId: null,
      },
    });
  });
});

describe("removeSocialPreview", () => {
  it("clears the placement for the signed-in teacher", async () => {
    clearSocialPreview.mockResolvedValue(true);
    const { removeSocialPreview } = await actions();
    const id = "55555555-5555-5555-5555-555555555555";
    expect(await removeSocialPreview(undefined, form({ previewId: id }))).toEqual({ ok: true });
    expect(clearSocialPreview).toHaveBeenCalledWith("teacher-1", id);
  });

  it("reports not-found for another teacher's preview", async () => {
    clearSocialPreview.mockResolvedValue(false);
    const { removeSocialPreview } = await actions();
    const result = await removeSocialPreview(
      undefined,
      form({ previewId: "55555555-5555-5555-5555-555555555555" }),
    );
    expect(result?.error).toMatch(/couldn't find/i);
  });

  it("rejects a malformed previewId", async () => {
    const { removeSocialPreview } = await actions();
    const result = await removeSocialPreview(undefined, form({ previewId: "nope" }));
    expect(result?.error).toBeTruthy();
    expect(clearSocialPreview).not.toHaveBeenCalled();
  });
});

describe("renameSocialPreviewImageAction", () => {
  it("passes her own id, never one from the form", async () => {
    renameSocialPreviewImage.mockResolvedValue(true);
    const { renameSocialPreviewImageAction } = await actions();
    const result = await renameSocialPreviewImageAction(
      undefined,
      form({ imageId: IMAGE.id, topic: "Bus stop joke", teacherId: "teacher-2" }),
    );
    expect(result).toEqual({ ok: true });
    expect(renameSocialPreviewImage).toHaveBeenCalledWith({
      teacherId: "teacher-1",
      imageId: IMAGE.id,
      topic: "Bus stop joke",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/get-students/communities");
  });

  it("reports a miss without saying whether the id exists", async () => {
    renameSocialPreviewImage.mockResolvedValue(false);
    const { renameSocialPreviewImageAction } = await actions();
    const result = await renameSocialPreviewImageAction(
      undefined,
      form({ imageId: IMAGE.id, topic: "x" }),
    );
    expect(result?.error).toMatch(/couldn't find/i);
  });
});

describe("deleteSocialPreviewImageAction", () => {
  it("deletes as the signed-in teacher and records it", async () => {
    deleteSocialPreviewImage.mockResolvedValue({ ok: true });
    const { deleteSocialPreviewImageAction } = await actions();
    const result = await deleteSocialPreviewImageAction(
      undefined,
      form({ imageId: IMAGE.id, teacherId: "teacher-2" }),
    );
    expect(result).toEqual({ ok: true });
    expect(deleteSocialPreviewImage).toHaveBeenCalledWith({
      teacherId: "teacher-1",
      imageId: IMAGE.id,
    });
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "social_preview_image_deleted",
      distinctId: "teacher-1",
      properties: { teacherId: "teacher-1" },
    });
  });

  it("explains the one refusal that is a real answer", async () => {
    deleteSocialPreviewImage.mockResolvedValue({ ok: false, reason: "posted" });
    const { deleteSocialPreviewImageAction } = await actions();
    const result = await deleteSocialPreviewImageAction(undefined, form({ imageId: IMAGE.id }));
    expect(result?.error).toMatch(/already marked as done/i);
  });

  it("says the same thing for another teacher's id as for a deleted one", async () => {
    deleteSocialPreviewImage.mockResolvedValue({ ok: false, reason: "not-found" });
    const { deleteSocialPreviewImageAction } = await actions();
    const result = await deleteSocialPreviewImageAction(undefined, form({ imageId: IMAGE.id }));
    expect(result?.error).toMatch(/couldn't find/i);
  });

  it("refuses a malformed id before reaching the domain at all", async () => {
    const { deleteSocialPreviewImageAction } = await actions();
    const result = await deleteSocialPreviewImageAction(undefined, form({ imageId: "../../etc" }));
    expect(result?.error).toBeTruthy();
    expect(deleteSocialPreviewImage).not.toHaveBeenCalled();
  });

  it("speaks her language", async () => {
    getPreferredLocale.mockResolvedValue("es-MX");
    deleteSocialPreviewImage.mockResolvedValue({ ok: false, reason: "posted" });
    const { deleteSocialPreviewImageAction } = await actions();
    const result = await deleteSocialPreviewImageAction(undefined, form({ imageId: IMAGE.id }));
    expect(result?.error).toMatch(/ya marcaste como hecha/i);
  });
});
