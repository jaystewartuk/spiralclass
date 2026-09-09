import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Every Get Students mutation must re-resolve the signed-in teacher and scope
// the write to her id. An activity id or community id arriving from a form is
// an untrusted value, never proof of ownership.

const addCommunity = vi.fn(async (_teacherId: string, _input: Record<string, unknown>) => ({
  id: "c1",
}));
const updateCommunity = vi.fn(
  async (_teacherId: string, _id: string, _input: Record<string, unknown>) => true,
);
const archiveCommunity = vi.fn(async () => true);
const restoreCommunity = vi.fn(async () => true);
const deleteCommunity = vi.fn(async () => true);
vi.mock("@/lib/marketing/communities", async () => {
  const actual = await vi.importActual<typeof import("@/lib/marketing/communities")>(
    "@/lib/marketing/communities",
  );
  return {
    communityInputSchema: actual.communityInputSchema,
    addCommunity,
    updateCommunity,
    archiveCommunity,
    restoreCommunity,
    deleteCommunity,
  };
});

const createActivity = vi.fn(async (_input: Record<string, unknown>) => "a1");
const markActivityDone = vi.fn(async () => true);
const skipActivity = vi.fn(async () => true);
const updateActivityBody = vi.fn(async () => true);
type PrepareResult = { ok: true; activityId: string } | { ok: false; reason: string };
const prepareActivity = vi.fn(async (_input: Record<string, unknown>): Promise<PrepareResult> => ({
  ok: true,
  activityId: "a1",
}));
const getOrCreateCommunityDraft = vi.fn(
  async (_input: Record<string, unknown>): Promise<{ activityId: string } | null> => ({
    activityId: "a1",
  }),
);
vi.mock("@/lib/marketing/activities", () => ({
  createActivity,
  getOrCreateCommunityDraft,
  markActivityDone,
  prepareActivity,
  skipActivity,
  updateActivityBody,
}));

const saveMarketingProfile = vi.fn();
const saveMemeSettings = vi.fn();
vi.mock("@/lib/marketing/profile", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/marketing/profile")>("@/lib/marketing/profile");
  return {
    marketingProfileInputSchema: actual.marketingProfileInputSchema,
    memeSettingsInputSchema: actual.memeSettingsInputSchema,
    saveMarketingProfile,
    saveMemeSettings,
  };
});

const regenerateWeeklyPlan = vi.fn(async () => null);
vi.mock("@/lib/marketing/plan", () => ({ regenerateWeeklyPlan }));

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1", bookingSlug: "mira" })),
}));
vi.mock("@/lib/subscriptions/service", () => ({
  loadEntitlements: vi.fn(async () => ({ isPro: true })),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const actions = await import("@/app/actions/marketing");

const ID = "11111111-1111-1111-1111-111111111111";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareActivity.mockResolvedValue({ ok: true, activityId: "a1" });
  markActivityDone.mockResolvedValue(true);
  skipActivity.mockResolvedValue(true);
  updateActivityBody.mockResolvedValue(true);
  updateCommunity.mockResolvedValue(true);
  archiveCommunity.mockResolvedValue(true);
  restoreCommunity.mockResolvedValue(true);
  deleteCommunity.mockResolvedValue(true);
});

describe("community actions", () => {
  it("rejects a nameless community", async () => {
    const state = await actions.addCommunityAction(undefined, form({ name: "", url: "" }));
    expect(state?.error).toBeTruthy();
    expect(addCommunity).not.toHaveBeenCalled();
  });

  it("rejects a link that isn't a URL", async () => {
    const state = await actions.addCommunityAction(
      undefined,
      form({ name: "Group", url: "not a url" }),
    );
    expect(state?.error).toBeTruthy();
  });

  it("passes the platform and policy through, scoped to the signed-in teacher", async () => {
    const state = await actions.addCommunityAction(
      undefined,
      form({
        name: "r/Spanish",
        url: "",
        platform: "reddit",
        promoPolicy: "prohibited",
        audienceNote: "learners",
      }),
    );
    expect(state?.ok).toBe(true);
    expect(addCommunity).toHaveBeenCalledWith("t1", {
      name: "r/Spanish",
      url: undefined,
      platform: "reddit",
      promoPolicy: "prohibited",
      audienceNote: "learners",
    });
  });

  it("ignores a platform or policy value that isn't in the registry", async () => {
    await actions.addCommunityAction(
      undefined,
      form({ name: "X", url: "", platform: "myspace", promoPolicy: "sure" }),
    );
    expect(addCommunity.mock.calls[0][1]).toMatchObject({
      platform: undefined,
      promoPolicy: undefined,
    });
  });

  it("refuses a malformed id rather than passing it to the store", async () => {
    for (const action of [
      actions.updateCommunityAction,
      actions.archiveCommunityAction,
      actions.restoreCommunityAction,
      actions.deleteCommunityAction,
    ]) {
      const state = await action(undefined, form({ id: "not-a-uuid", name: "X", url: "" }));
      expect(state?.error).toBeTruthy();
    }
    expect(updateCommunity).not.toHaveBeenCalled();
    expect(archiveCommunity).not.toHaveBeenCalled();
  });

  it("surfaces not-found when the row wasn't the teacher's", async () => {
    updateCommunity.mockResolvedValue(false);
    const state = await actions.updateCommunityAction(
      undefined,
      form({ id: ID, name: "X", url: "" }),
    );
    expect(state?.error).toBeTruthy();
  });

  it("archives rather than deletes, and revalidates the editor", async () => {
    const state = await actions.archiveCommunityAction(undefined, form({ id: ID }));
    expect(state?.ok).toBe(true);
    expect(archiveCommunity).toHaveBeenCalledWith("t1", ID);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/get-students/communities");
  });

  it("restores and hard-deletes when explicitly asked", async () => {
    expect((await actions.restoreCommunityAction(undefined, form({ id: ID })))?.ok).toBe(true);
    expect((await actions.deleteCommunityAction(undefined, form({ id: ID })))?.ok).toBe(true);
    expect(restoreCommunity).toHaveBeenCalledWith("t1", ID);
    expect(deleteCommunity).toHaveBeenCalledWith("t1", ID);
  });
});

describe("saveMarketingProfileAction", () => {
  it("splits comma-separated free text into a bounded list", async () => {
    const state = await actions.saveMarketingProfileAction(
      undefined,
      form({
        audiences: " expats , professionals ,, kids ",
        learnerLocations: "Oaxaca",
        levels: "",
        differentiator: "adults who already live here",
        weeklyMinutes: "90",
        goalNewStudentsPerMonth: "4",
      }),
    );
    expect(state?.ok).toBe(true);
    expect(saveMarketingProfile).toHaveBeenCalledWith("t1", {
      audiences: ["expats", "professionals", "kids"],
      learnerLocations: ["Oaxaca"],
      levels: [],
      differentiator: "adults who already live here",
      weeklyMinutes: 90,
      goalNewStudentsPerMonth: 4,
    });
  });

  it("caps the list at six entries rather than rejecting the whole form", async () => {
    await actions.saveMarketingProfileAction(
      undefined,
      form({
        audiences: "a,b,c,d,e,f,g,h",
        learnerLocations: "",
        levels: "",
        differentiator: "",
        weeklyMinutes: "60",
        goalNewStudentsPerMonth: "2",
      }),
    );
    expect(saveMarketingProfile.mock.calls[0][1].audiences).toHaveLength(6);
  });

  it("rejects an out-of-range time budget", async () => {
    const state = await actions.saveMarketingProfileAction(
      undefined,
      form({
        audiences: "",
        learnerLocations: "",
        levels: "",
        differentiator: "",
        weeklyMinutes: "999",
        goalNewStudentsPerMonth: "2",
      }),
    );
    expect(state?.error).toBeTruthy();
    expect(saveMarketingProfile).not.toHaveBeenCalled();
  });
});

describe("activity actions", () => {
  it("prepares with the teacher's entitlement and her optional steer", async () => {
    const state = await actions.prepareActivityAction(
      undefined,
      form({ id: ID, topic: "  the subjunctive  ", sourcePost: "someone asked X" }),
    );
    expect(state?.ok).toBe(true);
    expect(prepareActivity).toHaveBeenCalledWith({
      teacherId: "t1",
      activityId: ID,
      isPro: true,
      topic: "the subjunctive",
      sourcePost: "someone asked X",
    });
  });

  it("passes a blank steer through as null, not as an empty string", async () => {
    await actions.prepareActivityAction(undefined, form({ id: ID, topic: "   ", sourcePost: "" }));
    expect(prepareActivity.mock.calls[0][0]).toMatchObject({ topic: null, sourcePost: null });
  });

  it("returns the generation reason so the UI can say something specific", async () => {
    prepareActivity.mockResolvedValue({ ok: false, reason: "throttled" });
    const state = await actions.prepareActivityAction(undefined, form({ id: ID }));
    expect(state?.reason).toBe("throttled");
  });

  it("marks done, skips and saves an edited body, all teacher-scoped", async () => {
    expect((await actions.markActivityDoneAction(undefined, form({ id: ID })))?.ok).toBe(true);
    expect(markActivityDone).toHaveBeenCalledWith("t1", ID);

    expect((await actions.skipActivityAction(undefined, form({ id: ID })))?.ok).toBe(true);
    expect(skipActivity).toHaveBeenCalledWith("t1", ID);

    expect(
      (await actions.saveActivityBodyAction(undefined, form({ id: ID, body: "her words" })))?.ok,
    ).toBe(true);
    expect(updateActivityBody).toHaveBeenCalledWith("t1", ID, "her words");
  });

  it("refuses an empty edited body", async () => {
    const state = await actions.saveActivityBodyAction(undefined, form({ id: ID, body: "   " }));
    expect(state?.error).toBeTruthy();
    expect(updateActivityBody).not.toHaveBeenCalled();
  });

  it("reports failure when the row wasn't hers", async () => {
    markActivityDone.mockResolvedValue(false);
    expect((await actions.markActivityDoneAction(undefined, form({ id: ID })))?.error).toBeTruthy();
  });

  it("regenerates the week for the signed-in teacher only", async () => {
    expect((await actions.regeneratePlanAction(undefined, new FormData()))?.ok).toBe(true);
    expect(regenerateWeeklyPlan).toHaveBeenCalledWith({ teacherId: "t1" });
  });

  it("refuses an ad-hoc activity with an unknown kind or platform", async () => {
    const state = await actions.addActivityAction(
      undefined,
      form({ kind: "growth_hack", platform: "facebook_group" }),
    );
    expect(state?.error).toBeTruthy();
    expect(createActivity).not.toHaveBeenCalled();
  });

  it("creates an ad-hoc activity, dropping a malformed community id", async () => {
    const state = await actions.addActivityAction(
      undefined,
      form({ kind: "tip", platform: "facebook_group", communityId: "nope" }),
    );
    expect(state?.ok).toBe(true);
    expect(createActivity).toHaveBeenCalledWith({
      teacherId: "t1",
      kind: "tip",
      platform: "facebook_group",
      communityId: null,
    });
  });
});

describe("saveMemeSettingsAction", () => {
  it("saves her general image instructions against her own id", async () => {
    const { saveMemeSettingsAction } = await import("@/app/actions/marketing");
    const fd = new FormData();
    fd.set("memeBrief", "  Dry humour about supermarket Spanish.  ");
    fd.set("memeStyle", "retro");
    // Smuggled, and ignored: the teacher is re-resolved from the session.
    fd.set("teacherId", "t2");
    expect(await saveMemeSettingsAction(undefined, fd)).toEqual({ ok: true });
    expect(saveMemeSettings).toHaveBeenCalledWith("t1", {
      memeBrief: "Dry humour about supermarket Spanish.",
      memeStyle: "retro",
    });
  });

  it("clears the brief when she empties the textarea", async () => {
    const { saveMemeSettingsAction } = await import("@/app/actions/marketing");
    const fd = new FormData();
    fd.set("memeBrief", "");
    fd.set("memeStyle", "varied");
    await saveMemeSettingsAction(undefined, fd);
    expect(saveMemeSettings.mock.calls.at(-1)?.[1]).toMatchObject({ memeBrief: undefined });
  });

  it("degrades an unrecognised style to the default rather than failing her save", async () => {
    const { saveMemeSettingsAction } = await import("@/app/actions/marketing");
    const fd = new FormData();
    fd.set("memeStyle", "cinematic-8k");
    await saveMemeSettingsAction(undefined, fd);
    expect(saveMemeSettings.mock.calls.at(-1)?.[1]).toMatchObject({ memeStyle: "varied" });
  });
});

describe("generateCommunityPostAction", () => {
  const form = (over: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("communityId", "3f0c6a1e-6a2d-4f3b-9a11-2b7c0d5e8f90");
    fd.set("kind", "tip");
    fd.set("platform", "facebook_group");
    for (const [k, v] of Object.entries(over)) fd.set(k, v);
    return fd;
  };

  it("resolves the community's one draft as her, then prepares it", async () => {
    const { generateCommunityPostAction } = await import("@/app/actions/marketing");
    expect(
      await generateCommunityPostAction(undefined, form({ topic: "the subjunctive" })),
    ).toEqual({ ok: true });
    expect(getOrCreateCommunityDraft).toHaveBeenCalledWith({
      teacherId: "t1",
      communityId: "3f0c6a1e-6a2d-4f3b-9a11-2b7c0d5e8f90",
      kind: "tip",
      platform: "facebook_group",
    });
    expect(prepareActivity.mock.calls.at(-1)?.[0]).toMatchObject({
      teacherId: "t1",
      activityId: "a1",
      topic: "the subjunctive",
      // One Generate button costs one provider call: the image is its own
      // action, so this never spends an image allowance she did not ask to.
      withImage: false,
    });
  });

  it("fails the same way for another teacher's community as for a missing one", async () => {
    const { generateCommunityPostAction } = await import("@/app/actions/marketing");
    getOrCreateCommunityDraft.mockResolvedValueOnce(null);
    const result = await generateCommunityPostAction(undefined, form());
    expect(result?.error).toBeTruthy();
    expect(prepareActivity).not.toHaveBeenCalled();
  });

  it("refuses a kind or platform that is not in the registry", async () => {
    const { generateCommunityPostAction } = await import("@/app/actions/marketing");
    expect(
      (await generateCommunityPostAction(undefined, form({ kind: "growth_hack" })))?.error,
    ).toBeTruthy();
    expect(
      (await generateCommunityPostAction(undefined, form({ platform: "myspace" })))?.error,
    ).toBeTruthy();
    expect(getOrCreateCommunityDraft).not.toHaveBeenCalled();
  });

  it("surfaces the generator's own reason so the panel can explain it", async () => {
    const { generateCommunityPostAction } = await import("@/app/actions/marketing");
    prepareActivity.mockResolvedValueOnce({ ok: false, reason: "throttled" });
    expect(await generateCommunityPostAction(undefined, form())).toMatchObject({
      reason: "throttled",
    });
  });
});

describe("community promotion rules through the form", () => {
  it("reads the day checkboxes only when the form says it rendered them", async () => {
    const { updateCommunityAction } = await import("@/app/actions/marketing");
    const fd = new FormData();
    fd.set("id", "3f0c6a1e-6a2d-4f3b-9a11-2b7c0d5e8f90");
    fd.set("name", "Oaxaca Expats");
    fd.set("promoRulesPresent", "1");
    fd.append("promoWeekdays", "1");
    fd.append("promoWeekdays", "5");
    fd.set("promoEveryDays", "14");
    fd.set("promoLinksAllowed", "no");
    fd.set("promoNotes", "Friday thread only");
    await updateCommunityAction(undefined, fd);
    expect(updateCommunity.mock.calls.at(-1)?.[2]).toMatchObject({
      promoWeekdays: [1, 5],
      promoEveryDays: 14,
      promoLinksAllowed: "no",
      promoNotes: "Friday thread only",
    });
  });

  it("leaves the days alone when the form had no day picker", async () => {
    // A community whose policy forbids promotion renders no rule block at all.
    // Without the marker, that would be indistinguishable from "she unchecked
    // every day" and would silently blank a stored rule.
    const { updateCommunityAction } = await import("@/app/actions/marketing");
    const fd = new FormData();
    fd.set("id", "3f0c6a1e-6a2d-4f3b-9a11-2b7c0d5e8f90");
    fd.set("name", "Oaxaca Expats");
    await updateCommunityAction(undefined, fd);
    expect(updateCommunity.mock.calls.at(-1)?.[2].promoWeekdays).toBeUndefined();
  });

  it("records 'she cleared every day' when the picker was there and empty", async () => {
    const { updateCommunityAction } = await import("@/app/actions/marketing");
    const fd = new FormData();
    fd.set("id", "3f0c6a1e-6a2d-4f3b-9a11-2b7c0d5e8f90");
    fd.set("name", "Oaxaca Expats");
    fd.set("promoRulesPresent", "1");
    await updateCommunityAction(undefined, fd);
    expect(updateCommunity.mock.calls.at(-1)?.[2].promoWeekdays).toEqual([]);
  });
});
