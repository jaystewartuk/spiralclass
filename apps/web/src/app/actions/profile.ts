"use server";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { BOOKING_SLUG_MIN, validateBookingSlug } from "@/lib/slug";
import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  putTeacherPhoto,
  removeTeacherPhoto,
} from "@/lib/storage/teacher-photo";
import {
  MAX_VIDEO_BYTES,
  headTeacherVideoObject,
  presignTeacherVideoUpload,
  removeTeacherVideo,
  teacherVideoStorageKey,
} from "@/lib/storage/teacher-video";
import { logger } from "@/lib/logger";
import {
  BIO_MAX_LENGTH,
  HEADLINE_MAX_LENGTH,
  isAppLocale,
  isCaptionLanguage,
  isLanguageCode,
  materialStyleSchema,
  usesEnglishCopy,
} from "@spiralclass/shared";
import { teacherPublicWhatsappSchema } from "@/lib/validators";
import { normalizeE164 } from "@/lib/phone";
import { ensureTeacherFocusTags } from "@/lib/focus-tags";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import {
  readPriorCoachSignal,
  trackIntroVideoRemoved,
  trackIntroVideoSet,
} from "@/lib/intro-video/events";
import { maybeEmitMarketplaceReady, maybeEmitProfileCompleted } from "@/lib/marketplace-ready";
import {
  loadIntroVideoAnalysisState,
  type IntroVideoAnalysisState,
} from "@/lib/intro-video/analysis";
import { inngest } from "@/lib/inngest/client";
import { revalidateAfterAction } from "@/lib/revalidate";

const log = logger({ surface: "teacher-photo" });

export type ProfileState = { error?: string; ok?: boolean } | undefined;

// Saving the booking slug echoes the persisted value back so the editor can
// show the canonical (normalized) slug and rebuild the public link without a
// full reload.
export type SlugState = { error?: string; ok?: boolean; slug?: string } | undefined;

// Changes the teacher's booking slug — the "enlace de reservas" their students
// use at /b/<slug>. Editable both during onboarding (the preview step) and
// afterwards (Settings → Account). We normalize + validate offline, no-op when
// unchanged, and translate the unique-constraint violation into a friendly
// "taken" message rather than a 500. Changing the slug breaks any previously
// shared old link — that's the teacher's call to make.
export async function saveBookingSlugAction(
  _prev: SlugState,
  formData: FormData,
): Promise<SlugState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const raw = (formData.get("bookingSlug") ?? "").toString();
  const result = validateBookingSlug(raw);
  if (!result.ok) {
    const error =
      result.reason === "reserved"
        ? en
          ? "That link is reserved — choose another."
          : "Ese enlace está reservado — elige otro."
        : en
          ? `Use at least ${BOOKING_SLUG_MIN} letters or numbers.`
          : `Usa al menos ${BOOKING_SLUG_MIN} letras o números.`;
    return { error };
  }

  const slug = result.slug;
  // Unchanged (after normalization) — nothing to write, but report the
  // canonical value so the field settles on it.
  if (slug === teacher.bookingSlug) {
    return { ok: true, slug };
  }

  const previousSlug = teacher.bookingSlug;
  try {
    await prisma.teacher.update({
      where: { id: teacher.id },
      data: { bookingSlug: slug },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return {
        error: en
          ? "That link is already taken — choose another."
          : "Ese enlace ya está en uso — elige otro.",
      };
    }
    throw err;
  }

  trackServerEvent({
    name: "teacher_booking_slug_changed",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id },
  });
  await flushAnalytics();

  revalidateAfterAction("/settings/booking-page");
  // Bust both the old and new public pages so the old slug 404s and the new
  // one renders immediately.
  return { ok: true, slug };
}

// The language this teacher teaches (D-72) — the subject itself, since the
// platform is language-first. Drives the focus-tag seed pack AND names the
// subject in the AI material prompt. Storing it seeds that pack right away, so
// the focus picker is populated the next time it renders. Empty clears it (the
// picker then falls back to the neutral language pack). We never remove
// already-seeded tags on change — adding a pack is additive (D-20).
export async function saveTargetLanguageAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const raw = (formData.get("targetLanguage") ?? "").toString().trim();
  const targetLanguage = raw === "" ? null : raw;
  // Validated against the FULL registry, not the caption-capable subset: you can
  // teach Nahuatl even though nothing can caption it.
  if (targetLanguage && !isLanguageCode(targetLanguage)) {
    return { error: en ? "Unknown language." : "Idioma desconocido." };
  }

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { targetLanguage },
  });
  // Seed the pack for the chosen language (idempotent; skips anything already
  // there). Best-effort — the picker also self-heals on first read.
  if (targetLanguage) {
    await ensureTeacherFocusTags(teacher.id, targetLanguage, locale).catch(() => {});
  }

  trackServerEvent({
    name: "teacher_target_language_set",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, targetLanguage },
  });
  await flushAnalytics();

  // The settings page this form is on. The public /b/<slug> page shows the
  // taught language too, but it is a dynamic route with nothing prerendered to
  // invalidate, and a second revalidation here would cost this form its own
  // result — see @/lib/revalidate.
  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// Live-caption default language (D-27): the language this teacher teaches IN,
// used as the ASR/translation source unless a class has its own
// teacherLanguageOverride. Distinct from `targetLanguage` above: this is the
// language she SPEAKS while teaching, that is the language she teaches.
export async function saveTeachingLanguageAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const teachingLanguage = (formData.get("teachingLanguage") ?? "").toString().trim();
  if (!isCaptionLanguage(teachingLanguage)) {
    return { error: en ? "Unknown language." : "Idioma desconocido." };
  }

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { teachingLanguage },
  });

  // Rendered on the booking-page settings now (grouped with the taught language).
  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// The language her PUBLIC BOOKING PAGE renders in — a separate choice from her
// own UI language, because what her buyers read is a different fact from what
// she reads. The platform's first teacher is the case that proves it: her UI is
// Spanish and she sells Spanish lessons to English speakers, so her page must
// be English while her dashboard stays Spanish.
//
// "" clears the column back to NULL ("not chosen"), which resolves to
// PUBLIC_FUNNEL_LOCALE — the same thing every funnel rendered before this
// field existed.
export async function saveBookingPageLocaleAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const raw = (formData.get("bookingPageLocale") ?? "").toString().trim();
  if (raw !== "" && !isAppLocale(raw)) {
    return { error: en ? "Unknown language." : "Idioma desconocido." };
  }

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { bookingPageLocale: raw === "" ? null : raw },
  });

  // The funnel's locale is read per request by `funnelLocaleForSlug`, so the
  // public page picks this up on its next render; the settings page needs the
  // new value echoed back.
  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// Gap G4 (docs/features/library-materials.md) — opt-in toggle for
// auto-surfacing library materials at the student's level on the class page.
// Defaults off; a teacher who didn't ask for it doesn't get a new surface
// pushed onto her class pages.
export async function saveAutoSurfaceLevelMaterialsAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const enabled = formData.get("autoSurfaceLevelMaterials") != null;

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { autoSurfaceLevelMaterials: enabled },
  });

  trackServerEvent({
    name: "auto_surface_level_materials_toggled",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, enabled },
  });
  await flushAnalytics();

  revalidateAfterAction("/settings/account");
  return { ok: true };
}

// Auto-record classes (D-132) — opt-in toggle for letting the server start a
// class's recording once both parties are in the room, instead of waiting for
// the teacher to tap Record mid-lesson.
//
// Defaults off, and stays a per-teacher choice: this is her preference about
// her own classes, not a consent decision about her students. What a recording
// may capture is unchanged and decided elsewhere — the D-22 per-student
// insights consent still gates voice analysis, and both parties still see the
// recording indicator. See lib/video/call-recording.ts's maybeAutoStartRecording.
export async function saveAutoRecordClassesAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const enabled = formData.get("autoRecordClasses") != null;

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { autoRecordClasses: enabled },
  });

  trackServerEvent({
    name: "auto_record_classes_toggled",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, enabled },
  });
  await flushAnalytics();

  revalidateAfterAction("/settings/account");
  return { ok: true };
}

// Persists the teacher's public booking-page headline. Empty input clears it
// (stored as null) so the /b/<slug> page falls back to the generic
// "Clases con <name>" heading.
export async function saveHeadlineAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const raw = (formData.get("headline") ?? "").toString().trim();
  if (raw.length > HEADLINE_MAX_LENGTH) {
    return {
      error: en
        ? `Keep it under ${HEADLINE_MAX_LENGTH} characters.`
        : `Máximo ${HEADLINE_MAX_LENGTH} caracteres.`,
    };
  }

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { headline: raw === "" ? null : raw },
  });

  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// Persists the teacher's public booking-page bio (short "about me" text shown
// under the headline and used as the social/OG description). Empty clears it.
export async function saveBioAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const raw = (formData.get("bio") ?? "").toString().trim();
  if (raw.length > BIO_MAX_LENGTH) {
    return {
      error: en
        ? `Keep it under ${BIO_MAX_LENGTH} characters.`
        : `Máximo ${BIO_MAX_LENGTH} caracteres.`,
    };
  }

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { bio: raw === "" ? null : raw },
  });
  await maybeEmitProfileCompleted(prisma, teacher.id);
  await maybeEmitMarketplaceReady(prisma, teacher.id);

  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// Persists the teacher's PUBLIC-facing WhatsApp number — a "Chat on WhatsApp"
// button shown on /b/<slug>. Deliberately separate from
// updateMyTeacherContactAction (teacher-account.ts), which edits the private
// account phone: publishing a number on the public page is its own opt-in,
// not a republishing of the account field (see schema.prisma's
// Teacher.publicWhatsappE164). An empty field clears the number and hides the
// button. Uses the plain wa.me deep-link D-42 kept — no Meta integration.
export async function saveBookingPageWhatsappAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const parsed = teacherPublicWhatsappSchema(locale).safeParse({
    whatsapp: formData.get("whatsapp"),
    whatsappCountry: formData.get("whatsappCountry") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid phone number." : "Número inválido."),
    };
  }

  const publicWhatsappE164 = parsed.data.whatsapp
    ? normalizeE164(parsed.data.whatsapp, parsed.data.whatsappCountry ?? teacher.country)
    : null;

  if (publicWhatsappE164 !== teacher.publicWhatsappE164) {
    await prisma.teacher.update({
      where: { id: teacher.id },
      data: { publicWhatsappE164 },
    });
    trackServerEvent({
      name: "teacher_public_whatsapp_updated",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, isSet: publicWhatsappE164 !== null },
    });
    await flushAnalytics();
  }

  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// Persists the teacher's AI material style (D-78) — the tone/register, learner
// age, target-language variety, and free-text note applied to every AI-generated
// material via resolveSubject. Validated with the shared materialStyleSchema so
// web and mobile enforce identical bounds; each field clears to null.
export async function saveMaterialStyleAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();

  const parsed = materialStyleSchema(locale).safeParse({
    tone: formData.get("tone"),
    learnerAge: formData.get("learnerAge"),
    // Vocabulary difficulty (D-80) reached this form with the settings-page
    // redesign. The form posts the stored value back unchanged unless the
    // teacher moves the dial, so a save can't silently wipe a stored setting.
    vocabulary: formData.get("vocabulary"),
    languageVariety: formData.get("languageVariety"),
    customInstructions: formData.get("customInstructions"),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        (usesEnglishCopy(locale) ? "Invalid input" : "Entrada inválida"),
    };
  }
  const { tone, learnerAge, vocabulary, languageVariety, customInstructions } = parsed.data;

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: {
      materialTone: tone,
      materialLearnerAge: learnerAge,
      materialVocabulary: vocabulary,
      materialLanguageVariety: languageVariety,
      materialCustomInstructions: customInstructions,
    },
  });

  trackServerEvent({
    name: "material_style_saved",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      tone,
      learnerAge,
      vocabulary,
      hasVariety: languageVariety != null,
      hasCustom: customInstructions != null,
    },
  });
  await flushAnalytics();

  revalidateAfterAction("/settings/materials");
  return { ok: true };
}

// Uploads the teacher's profile photo to the public `teacher-photos` bucket
// (one object per teacher; re-upload replaces in place) and stores the key.
// Service-role upload — same pattern as class-materials; ownership is already
// established by requireTeacher and the path is scoped to the teacher id.
export async function saveTeacherPhotoAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { error: en ? "Choose an image first." : "Elige una imagen primero." };
  }
  const ext = ALLOWED_PHOTO_TYPES[file.type];
  if (!ext) {
    return {
      error: en ? "Use a JPG, PNG or WebP image." : "Usa una imagen JPG, PNG o WebP.",
    };
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return {
      error: en ? "The image must be under 5 MB." : "La imagen debe pesar menos de 5 MB.",
    };
  }

  const { path, error: upErr } = await putTeacherPhoto(teacher.id, file);
  if (upErr) {
    log.warn("upload failed", { error: upErr });
    return {
      error: en ? `We couldn't upload the image: ${upErr}` : `No pudimos subir la imagen: ${upErr}`,
    };
  }

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { photoPath: path },
  });
  await maybeEmitProfileCompleted(prisma, teacher.id);
  await maybeEmitMarketplaceReady(prisma, teacher.id);

  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// Removes the teacher's profile photo (clears the pointer and deletes the
// object best-effort).
export async function removeTeacherPhotoAction(): Promise<ProfileState> {
  const teacher = await requireTeacher();
  if (teacher.photoPath) {
    await removeTeacherPhoto(teacher.photoPath);
  }
  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { photoPath: null },
  });
  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// Reasonable ceiling on the recorded/stored intro video (D-73). ~5 minutes is
// well beyond the ~45–60s intro we nudge for, but leaves room for an uploaded
// clip; the AI coach (Layer 3) later flags anything much over ~60s as too long.
const INTRO_VIDEO_MAX_DURATION_MS = 5 * 60 * 1000;

// Intro-video upload is DIRECT-TO-R2: a gallery clip easily exceeds the
// Server-Action body limit (25 MB), so the file
// never goes through the action. Two steps:
//   1) presignIntroVideoUploadAction — mint a presigned PUT ticket (the browser
//      PUTs the bytes straight to R2, allow-listed in the CSP connect-src).
//   2) finalizeIntroVideoAction — HEAD-check size/existence, store the key +
//      duration, kick off the coach pipeline.
export type PresignState =
  { ok: true; uploadUrl: string; storagePath: string } | { ok: false; error: string };

export async function presignIntroVideoUploadAction(contentType: string): Promise<PresignState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const presigned = presignTeacherVideoUpload(teacher.id, contentType);
  if ("error" in presigned) {
    return {
      ok: false,
      error:
        presigned.error === "bad-type"
          ? en
            ? "Use an MP4, WebM or MOV video."
            : "Usa un video MP4, WebM o MOV."
          : en
            ? "Video upload isn't available right now."
            : "La subida de video no está disponible ahora.",
    };
  }
  return { ok: true, uploadUrl: presigned.uploadUrl, storagePath: presigned.storagePath };
}

// Finalize after the browser uploaded straight to R2. Re-derives the key
// server-side (never trusts the client), HEAD-checks the object exists and is
// within the cap, then stores it + duration and kicks off the coach pipeline.
export async function finalizeIntroVideoAction(
  durationMs: number | null,
  // How the clip was captured, forwarded by the client purely so the analytics
  // funnel can split the in-app recorder from a picked file — the two have very
  // different completion and failure profiles. Defaulted so an older client
  // (or a caller that doesn't care) still works.
  source: "record" | "upload" = "record",
): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const key = teacherVideoStorageKey(teacher.id);
  const size = await headTeacherVideoObject(key);
  if (size === null) {
    return {
      error: en
        ? "The upload didn't finish — please try again."
        : "La subida no se completó — inténtalo de nuevo.",
    };
  }
  if (size > MAX_VIDEO_BYTES) {
    await removeTeacherVideo(key);
    return {
      error: en
        ? "The video must be under 50 MB — try a shorter clip."
        : "El video debe pesar menos de 50 MB — prueba un clip más corto.",
    };
  }

  const clamped =
    durationMs != null && Number.isFinite(durationMs) && durationMs > 0
      ? Math.min(Math.round(durationMs), INTRO_VIDEO_MAX_DURATION_MS)
      : null;

  // Read the outgoing video's coaching state BEFORE anything overwrites it —
  // this is what makes "did she re-record after reading the AI feedback?"
  // measurable (see lib/intro-video/events.ts).
  const isReplacement = Boolean(teacher.introVideoPath);
  const prior = await readPriorCoachSignal(teacher.id);

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { introVideoPath: key, introVideoDurationMs: clamped },
  });

  // Kick off the async intro-video coach pipeline (D-73). Best-effort: the
  // handler is Pro-gated + flag-gated and no-ops when dormant, so a send failure
  // must never block saving the video.
  await inngest
    .send({ name: "intro-video.ready", data: { teacherId: teacher.id, videoPath: key } })
    .catch((err) => log.warn("intro-video.ready emit failed", { error: String(err) }));

  trackIntroVideoSet({
    teacherId: teacher.id,
    surface: "web",
    source,
    durationMs: clamped,
    sizeBytes: size,
    isReplacement,
    prior,
  });
  await flushAnalytics();

  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// Removes the teacher's intro video (clears the pointer + duration and deletes
// the object best-effort).
export async function removeIntroVideoAction(): Promise<ProfileState> {
  const teacher = await requireTeacher();
  if (teacher.introVideoPath) {
    await removeTeacherVideo(teacher.introVideoPath);
  }
  // Read before the delete below wipes it — whether a teacher deletes a video
  // that had just been coached is a signal about the coach's tone, not only
  // about the video.
  const prior = await readPriorCoachSignal(teacher.id);
  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { introVideoPath: null, introVideoDurationMs: null },
  });
  // Drop any stale AI analysis (D-73, Layer 2) — the video it described is gone.
  await prisma.introVideoAnalysis.deleteMany({ where: { teacherId: teacher.id } });
  trackIntroVideoRemoved({
    teacherId: teacher.id,
    surface: "web",
    hadCoachFeedback: prior.hadCoachFeedback,
  });
  await flushAnalytics();
  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// Polling target for the AI Coach panel (D-73, Layer 3): lets the client see
// the pipeline move through pending → transcribing → transcribed/failed
// without a full page reload, and picks up the true current state whenever
// the teacher navigates back to this page.
export async function getIntroVideoAnalysisStateAction(): Promise<IntroVideoAnalysisState> {
  const teacher = await requireTeacher();
  return loadIntroVideoAnalysisState(teacher.id);
}

// Re-run the AI Coach pipeline after a failure. Eagerly flips the row back to
// "pending" so the panel shows processing immediately rather than waiting for
// the Inngest job to pick it up, then re-sends the same event
// processIntroVideoReady already treats as idempotent (upsert by teacherId).
export async function retryIntroVideoAnalysisAction(): Promise<ProfileState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  if (!teacher.introVideoPath) {
    return { error: en ? "There's no video to analyze." : "No hay un video para analizar." };
  }
  await prisma.introVideoAnalysis.upsert({
    where: { teacherId: teacher.id },
    create: { teacherId: teacher.id, videoPath: teacher.introVideoPath, status: "pending" },
    update: { status: "pending", error: null },
  });
  await inngest
    .send({
      name: "intro-video.ready",
      data: { teacherId: teacher.id, videoPath: teacher.introVideoPath },
    })
    .catch((err) => log.warn("intro-video.ready retry emit failed", { error: String(err) }));
  revalidateAfterAction("/settings/booking-page");
  return { ok: true };
}

// A self-submitting toggle echoes its new value back so the client can confirm
// which state actually persisted.
export type IntroVideoTranscriptOptInState = { ok?: boolean; optedIn?: boolean } | undefined;

// Booking-page AI-readability: explicit opt-in to publish the intro-video
// TRANSCRIPT (not the video itself — that's already public) in the /b/<slug>
// VideoObject JSON-LD. Default off; the video's own publicness isn't the same
// decision as its transcript becoming machine-readable text. Settings only
// shows this toggle once a transcript actually exists, but the write itself
// carries no such check — flipping it on before a transcript exists is
// harmless (the public page reads it as null and renders no transcript claim).
export async function saveIntroVideoTranscriptPublicOptInAction(
  _prev: IntroVideoTranscriptOptInState,
  formData: FormData,
): Promise<IntroVideoTranscriptOptInState> {
  const teacher = await requireTeacher();
  const optedIn = formData.get("introVideoTranscriptPublicOptIn") != null;

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { introVideoTranscriptPublicOptIn: optedIn },
  });

  trackServerEvent({
    name: "intro_video_transcript_opt_in_toggled",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, optedIn },
  });
  await flushAnalytics();

  revalidateAfterAction("/settings/booking-page");
  return { ok: true, optedIn };
}
