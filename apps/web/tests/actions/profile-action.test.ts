import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher public-profile actions. Headline/bio: length validation + empty
// clears to null. Photo: file-presence, content-type and size validation
// before any upload, then the upload + pointer write; remove clears the
// pointer and best-effort deletes the object.

const state = {
  teacher: {
    id: "t1",
    bookingSlug: "mira",
    photoPath: null as string | null,
    introVideoPath: null as string | null,
    country: "MX",
    publicWhatsappE164: null as string | null,
  },
  // Backs maybeEmitProfileCompleted's post-save re-check (onboarding
  // activation audit) — independent of state.teacher above, which the
  // actions under test never read photoPath/bio back from.
  profile: {
    photoPath: null as string | null,
    bio: null as string | null,
    profileCompletedAt: null as Date | null,
    // maybeEmitMarketplaceReady reads the payout rail off the relation
    // (D-113); an empty list is "no transfer instrument configured".
    pricingCurrency: "MXN",
    payoutInstruments: [] as { kind: string; enabled: boolean }[],
  },
};
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn(async () => {}) } }));
vi.mock("@/lib/auth", () => ({ requireTeacher: vi.fn(async () => state.teacher) }));

const teacherUpdate = vi.fn(async (arg: { data: Record<string, unknown> }) => {
  // Mirror the write into state.profile so maybeEmitProfileCompleted's
  // findUnique re-check (below) sees what this same action just saved,
  // same as a real DB would.
  if ("photoPath" in arg.data) state.profile.photoPath = arg.data.photoPath as string | null;
  if ("bio" in arg.data) state.profile.bio = arg.data.bio as string | null;
  // Mirror into state.teacher too, so saveBookingPageWhatsappAction's
  // no-op-when-unchanged guard (reading straight off the requireTeacher
  // mock) sees a second save in the same test as a real DB round-trip would.
  if ("publicWhatsappE164" in arg.data) {
    state.teacher.publicWhatsappE164 = arg.data.publicWhatsappE164 as string | null;
  }
  return {};
});
const teacherFindUnique = vi.fn(async () => state.profile);
const teacherUpdateMany = vi.fn(async () => {
  if (state.profile.profileCompletedAt) return { count: 0 };
  state.profile.profileCompletedAt = new Date();
  return { count: 1 };
});
const introVideoAnalysisFindUnique = vi.fn(
  async () => null as { status: string; coachFeedback: unknown; error: string | null } | null,
);
const introVideoAnalysisUpsert = vi.fn(async () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // D-113: the payout-instrument delegate. Empty by default — a test that
    // cares about a specific instrument overrides it.
    teacherPayoutInstrument: {
      findMany: async () => [],
      findFirst: async () => null,
      findUnique: async () => null,
      count: async () => 0,
      upsert: async () => ({
        kind: "wise",
        enabled: false,
        wiseHandle: null,
        schemeId: null,
        details: null,
      }),
      updateMany: async () => ({ count: 0 }),
    },
    teacher: {
      update: teacherUpdate,
      findUnique: teacherFindUnique,
      updateMany: teacherUpdateMany,
    },
    introVideoAnalysis: {
      findUnique: introVideoAnalysisFindUnique,
      upsert: introVideoAnalysisUpsert,
    },
  },
}));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent,
  flushAnalytics: vi.fn(async () => {}),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const upload = vi.fn(async () => ({ error: null as { message: string } | null }));
const remove = vi.fn(async () => ({ error: null as { message: string } | null }));
const ensureBucket = vi.fn(async () => {});
vi.mock("@/lib/storage/provider", () => ({
  getStorageProvider: () => ({
    upload,
    remove,
    ensureBucket,
    publicUrl: vi.fn(),
    createSignedUrl: vi.fn(),
  }),
  PUBLIC_VERSIONED_ASSET_CACHE_CONTROL: "public, max-age=31536000, immutable",
}));

// Intro-video storage helpers (presigned direct-to-R2). Mocked so the action
// tests don't touch real R2 — the presign/HEAD internals are covered in
// tests/storage/teacher-video.test.ts.
const presignTeacherVideoUpload = vi.fn();
const headTeacherVideoObject = vi.fn();
const removeTeacherVideo = vi.fn(async () => {});
vi.mock("@/lib/storage/teacher-video", () => ({
  presignTeacherVideoUpload,
  headTeacherVideoObject,
  removeTeacherVideo,
  teacherVideoStorageKey: (id: string) => id,
  MAX_VIDEO_BYTES: 50 * 1024 * 1024,
}));

const {
  saveHeadlineAction,
  saveBioAction,
  saveBookingPageLocaleAction,
  saveBookingPageWhatsappAction,
  saveTeacherPhotoAction,
  removeTeacherPhotoAction,
  presignIntroVideoUploadAction,
  finalizeIntroVideoAction,
  getIntroVideoAnalysisStateAction,
  retryIntroVideoAnalysisAction,
  saveIntroVideoTranscriptPublicOptInAction,
  saveAutoRecordClassesAction,
  saveAutoSurfaceLevelMaterialsAction,
} = await import("@/app/actions/profile");

function field(name: string, value: string): FormData {
  const f = new FormData();
  f.set(name, value);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.teacher = {
    id: "t1",
    bookingSlug: "mira",
    photoPath: null,
    introVideoPath: null,
    country: "MX",
    publicWhatsappE164: null,
  };
  state.profile = {
    photoPath: null,
    bio: null,
    profileCompletedAt: null,
    pricingCurrency: "MXN",
    payoutInstruments: [],
  };
  introVideoAnalysisFindUnique.mockResolvedValue(null);
});

describe("saveHeadlineAction", () => {
  it("rejects an over-long headline", async () => {
    const res = await saveHeadlineAction(undefined, field("headline", "x".repeat(81)));
    expect(res).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("saves a headline", async () => {
    const res = await saveHeadlineAction(undefined, field("headline", "Clases divertidas"));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({ headline: "Clases divertidas" });
  });

  it("clears the headline to null on empty input", async () => {
    await saveHeadlineAction(undefined, field("headline", "   "));
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({ headline: null });
  });
});

describe("saveBioAction", () => {
  it("rejects an over-long bio and clears on empty", async () => {
    expect(await saveBioAction(undefined, field("bio", "x".repeat(281)))).toHaveProperty("error");
    await saveBioAction(undefined, field("bio", ""));
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({ bio: null });
  });

  it("fires profile_completed when a bio save is the last piece (photo already set)", async () => {
    state.profile.photoPath = "t1";
    await saveBioAction(undefined, field("bio", "Profesora de inglés desde 2015."));
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "profile_completed", distinctId: "t1" }),
    );
  });

  it("does not fire profile_completed without a photo yet", async () => {
    await saveBioAction(undefined, field("bio", "Profesora de inglés desde 2015."));
    expect(trackServerEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "profile_completed" }),
    );
  });

  it("only fires profile_completed once (idempotent across repeated saves)", async () => {
    state.profile.photoPath = "t1";
    await saveBioAction(undefined, field("bio", "Bio uno"));
    await saveBioAction(undefined, field("bio", "Bio dos"));
    expect(
      trackServerEvent.mock.calls.filter((c) => c[0].name === "profile_completed"),
    ).toHaveLength(1);
  });
});

// Separate opt-in field from the account phone (see schema.prisma's
// Teacher.publicWhatsappE164) — its own action, so its own test block.
describe("saveBookingPageWhatsappAction", () => {
  it("rejects a malformed number without writing anything", async () => {
    const res = await saveBookingPageWhatsappAction(undefined, field("whatsapp", "not-a-number"));
    expect(res).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("normalizes and saves a valid number using the teacher's own country as the default hint", async () => {
    const res = await saveBookingPageWhatsappAction(undefined, field("whatsapp", "55 1234 5678"));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({ publicWhatsappE164: "+525512345678" });
  });

  it("prefers an explicit whatsappCountry hint over the teacher's own country", async () => {
    const form = new FormData();
    form.set("whatsapp", "4155550123");
    form.set("whatsappCountry", "US");
    await saveBookingPageWhatsappAction(undefined, form);
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({ publicWhatsappE164: "+14155550123" });
  });

  it("clears the number to null on empty input", async () => {
    state.teacher.publicWhatsappE164 = "+525512345678";
    const res = await saveBookingPageWhatsappAction(undefined, field("whatsapp", ""));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({ publicWhatsappE164: null });
  });

  it("no-ops (no DB write, no analytics event) when the value is unchanged", async () => {
    const res = await saveBookingPageWhatsappAction(undefined, field("whatsapp", ""));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).not.toHaveBeenCalled();
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("fires teacher_public_whatsapp_updated with isSet on a real change", async () => {
    await saveBookingPageWhatsappAction(undefined, field("whatsapp", "5512345678"));
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "teacher_public_whatsapp_updated",
        distinctId: "t1",
        properties: { teacherId: "t1", isSet: true },
      }),
    );
  });

  it("fires teacher_public_whatsapp_updated with isSet: false on a clear", async () => {
    state.teacher.publicWhatsappE164 = "+525512345678";
    await saveBookingPageWhatsappAction(undefined, field("whatsapp", ""));
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ properties: { teacherId: "t1", isSet: false } }),
    );
  });
});

describe("saveTeacherPhotoAction", () => {
  function photoForm(file: File | string): FormData {
    const f = new FormData();
    f.set("photo", file);
    return f;
  }

  it("requires a non-empty file", async () => {
    const res = await saveTeacherPhotoAction(undefined, photoForm(new File([], "x.png")));
    expect(res).toHaveProperty("error");
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a disallowed content type", async () => {
    const gif = new File([new Uint8Array([1, 2, 3])], "a.gif", { type: "image/gif" });
    expect(await saveTeacherPhotoAction(undefined, photoForm(gif))).toHaveProperty("error");
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects an oversized image", async () => {
    const big = new File([new Uint8Array(6 * 1024 * 1024)], "a.png", { type: "image/png" });
    expect(await saveTeacherPhotoAction(undefined, photoForm(big))).toHaveProperty("error");
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads a valid image and stores the pointer", async () => {
    const ok = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    const res = await saveTeacherPhotoAction(undefined, photoForm(ok));
    expect(res).toEqual({ ok: true });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({ photoPath: "t1" });
  });

  it("surfaces an upload error", async () => {
    upload.mockResolvedValueOnce({ error: { message: "storage full" } });
    const ok = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    expect(await saveTeacherPhotoAction(undefined, photoForm(ok))).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("fires profile_completed when a photo upload is the last piece (bio already set)", async () => {
    state.profile.bio = "Profesora de inglés desde 2015.";
    const ok = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    await saveTeacherPhotoAction(undefined, photoForm(ok));
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "profile_completed", distinctId: "t1" }),
    );
  });

  it("does not fire profile_completed without a bio yet", async () => {
    const ok = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    await saveTeacherPhotoAction(undefined, photoForm(ok));
    expect(trackServerEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "profile_completed" }),
    );
  });
});

describe("removeTeacherPhotoAction", () => {
  it("clears the pointer even when there was no photo", async () => {
    const res = await removeTeacherPhotoAction();
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({ photoPath: null });
  });
});

describe("presignIntroVideoUploadAction", () => {
  it("returns the presigned ticket for an allowed type", async () => {
    presignTeacherVideoUpload.mockReturnValueOnce({
      uploadUrl: "https://r2/put",
      storagePath: "t1",
    });
    const res = await presignIntroVideoUploadAction("video/mp4");
    expect(res).toEqual({ ok: true, uploadUrl: "https://r2/put", storagePath: "t1" });
  });

  it("surfaces a bad-type error without a ticket", async () => {
    presignTeacherVideoUpload.mockReturnValueOnce({ error: "bad-type" });
    const res = await presignIntroVideoUploadAction("application/octet-stream");
    expect(res.ok).toBe(false);
    expect(res).toHaveProperty("error");
  });
});

describe("finalizeIntroVideoAction", () => {
  it("errors (no store) when the object never landed in R2", async () => {
    headTeacherVideoObject.mockResolvedValueOnce(null);
    const res = await finalizeIntroVideoAction(30_000);
    expect(res).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("rejects + deletes an oversized upload", async () => {
    headTeacherVideoObject.mockResolvedValueOnce(60 * 1024 * 1024); // > 50 MB cap
    const res = await finalizeIntroVideoAction(30_000);
    expect(res).toHaveProperty("error");
    expect(removeTeacherVideo).toHaveBeenCalledWith("t1");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("stores the key + clamped duration on a valid upload", async () => {
    headTeacherVideoObject.mockResolvedValueOnce(2 * 1024 * 1024);
    const res = await finalizeIntroVideoAction(30_000);
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({
      introVideoPath: "t1",
      introVideoDurationMs: 30_000,
    });
  });

  it("stores a null duration when none is provided", async () => {
    headTeacherVideoObject.mockResolvedValueOnce(2 * 1024 * 1024);
    await finalizeIntroVideoAction(null);
    expect(teacherUpdate.mock.calls[0][0].data).toEqual({
      introVideoPath: "t1",
      introVideoDurationMs: null,
    });
  });

  it("reports the capture source and the real stored size", async () => {
    // `source` splits the in-app recorder from a gallery pick (different
    // completion + failure profiles); `sizeBytes` is what makes a failure rate
    // readable against what was actually being uploaded.
    headTeacherVideoObject.mockResolvedValueOnce(3 * 1024 * 1024);
    await finalizeIntroVideoAction(30_000, "upload");
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "teacher_intro_video_set",
        properties: expect.objectContaining({
          surface: "web",
          source: "upload",
          sizeBytes: 3 * 1024 * 1024,
        }),
      }),
    );
  });

  it("defaults the source to the in-app recorder", async () => {
    headTeacherVideoObject.mockResolvedValueOnce(2 * 1024 * 1024);
    await finalizeIntroVideoAction(30_000);
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "teacher_intro_video_set",
        properties: expect.objectContaining({ source: "record" }),
      }),
    );
  });
});

describe("getIntroVideoAnalysisStateAction", () => {
  it("reports no analysis when no video/row exists yet", async () => {
    const res = await getIntroVideoAnalysisStateAction();
    expect(res).toEqual({ status: null, coach: null, error: null, hasTranscript: false });
  });

  it("surfaces the pipeline's current status/coach/error", async () => {
    introVideoAnalysisFindUnique.mockResolvedValueOnce({
      status: "transcribed",
      coachFeedback: { overall: "Great intro!", strengths: ["Clear"], improvements: [] },
      error: null,
    });
    const res = await getIntroVideoAnalysisStateAction();
    expect(res.status).toBe("transcribed");
    expect(res.coach).toEqual({ overall: "Great intro!", strengths: ["Clear"], improvements: [] });
  });
});

describe("saveIntroVideoTranscriptPublicOptInAction", () => {
  it("turns the opt-in on and echoes the new value", async () => {
    const res = await saveIntroVideoTranscriptPublicOptInAction(
      undefined,
      field("introVideoTranscriptPublicOptIn", "on"),
    );
    expect(res).toEqual({ ok: true, optedIn: true });
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { introVideoTranscriptPublicOptIn: true },
    });
  });

  it("turns the opt-in off when the checkbox is absent from the form", async () => {
    const res = await saveIntroVideoTranscriptPublicOptInAction(undefined, new FormData());
    expect(res).toEqual({ ok: true, optedIn: false });
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { introVideoTranscriptPublicOptIn: false },
    });
  });
});

describe("retryIntroVideoAnalysisAction", () => {
  it("errors without re-sending when there's no video to analyze", async () => {
    const res = await retryIntroVideoAnalysisAction();
    expect(res).toHaveProperty("error");
    expect(introVideoAnalysisUpsert).not.toHaveBeenCalled();
  });

  it("flips the analysis row back to pending and re-sends the event", async () => {
    state.teacher.introVideoPath = "t1";
    const res = await retryIntroVideoAnalysisAction();
    expect(res).toEqual({ ok: true });
    expect(introVideoAnalysisUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: "t1" },
        update: { status: "pending", error: null },
      }),
    );
  });
});

// The language her PUBLIC booking page renders in — her own setting, and
// deliberately NOT derived from her `locale`. The platform's first teacher
// reads Spanish and sells Spanish lessons to English speakers, so her page
// must be English while her dashboard stays Spanish; nothing already on the
// row predicts that, which is why this column exists.
describe("saveBookingPageLocaleAction", () => {
  it("persists a registered locale", async () => {
    const res = await saveBookingPageLocaleAction(undefined, field("bookingPageLocale", "en"));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { bookingPageLocale: "en" } }),
    );
  });

  it("stores a non-English choice just the same", async () => {
    await saveBookingPageLocaleAction(undefined, field("bookingPageLocale", "es-MX"));
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { bookingPageLocale: "es-MX" } }),
    );
  });

  // NULL is "she has not chosen", which resolves to PUBLIC_FUNNEL_LOCALE —
  // the same thing every funnel rendered before this field existed.
  it("clears back to not-chosen on an empty value", async () => {
    const res = await saveBookingPageLocaleAction(undefined, field("bookingPageLocale", ""));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { bookingPageLocale: null } }),
    );
  });

  it("rejects a tag outside the locale registry without touching the DB", async () => {
    const res = await saveBookingPageLocaleAction(undefined, field("bookingPageLocale", "zz-ZZ"));
    expect(res).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("never writes her own UI locale column", async () => {
    // The bug this guards: conflating the two is what made a Spanish-reading
    // teacher's English-speaking buyers get a Spanish checkout.
    await saveBookingPageLocaleAction(undefined, field("bookingPageLocale", "en"));
    const data = teacherUpdate.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty("locale");
  });
});

// D-132 — the auto-record-classes opt-in. A checkbox action, so the whole
// behaviour is "did an absent field mean off"; the interesting part is that it
// writes ONLY this column, because conflating a teacher's preference about her
// own classes with a consent decision about her students is the mistake this
// setting has to keep not making.
describe("saveAutoRecordClassesAction", () => {
  it("turns it on when the checkbox posted a value", async () => {
    const res = await saveAutoRecordClassesAction(undefined, field("autoRecordClasses", "on"));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1" }, data: { autoRecordClasses: true } }),
    );
  });

  // An unchecked Radix checkbox posts nothing at all, which is the only way
  // this action ever sees "off".
  it("turns it off when the field is absent", async () => {
    const res = await saveAutoRecordClassesAction(undefined, new FormData());
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { autoRecordClasses: false } }),
    );
  });

  it("never writes a consent column alongside it", async () => {
    await saveAutoRecordClassesAction(undefined, field("autoRecordClasses", "on"));
    const data = teacherUpdate.mock.calls[0]![0].data;
    expect(Object.keys(data)).toEqual(["autoRecordClasses"]);
  });

  it("tracks the toggle and revalidates the settings page", async () => {
    await saveAutoRecordClassesAction(undefined, field("autoRecordClasses", "on"));
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "auto_record_classes_toggled",
      distinctId: "t1",
      properties: { teacherId: "t1", enabled: true },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/account");
  });
});

// The other checkbox action on the same page, and the same contract: a field
// that is PRESENT means on, an ABSENT field means off. Untested until the
// account-page restructure found that its form could not express "absent" —
// it mirrored the Radix checkbox into `<input type="hidden" value="">`, which
// still submits, so this action was handed `""` and wrote `true` on every
// save. The client-side half of the fix is asserted in
// tests/settings/account-page-structure.test.tsx.
describe("saveAutoSurfaceLevelMaterialsAction", () => {
  it("turns it on when the checkbox posted a value", async () => {
    const res = await saveAutoSurfaceLevelMaterialsAction(
      undefined,
      field("autoSurfaceLevelMaterials", "on"),
    );
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1" }, data: { autoSurfaceLevelMaterials: true } }),
    );
  });

  it("turns it off when the field is absent", async () => {
    const res = await saveAutoSurfaceLevelMaterialsAction(undefined, new FormData());
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { autoSurfaceLevelMaterials: false } }),
    );
  });

  it("reads an empty string as ON, which is why the form must omit the field", async () => {
    // Pinning the behaviour the bug depended on, so the next person changing
    // either side knows which half the contract lives in.
    await saveAutoSurfaceLevelMaterialsAction(undefined, field("autoSurfaceLevelMaterials", ""));
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { autoSurfaceLevelMaterials: true } }),
    );
  });

  it("tracks the toggle and revalidates the settings page", async () => {
    await saveAutoSurfaceLevelMaterialsAction(undefined, field("autoSurfaceLevelMaterials", "on"));
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "auto_surface_level_materials_toggled",
      distinctId: "t1",
      properties: { teacherId: "t1", enabled: true },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/account");
  });
});
