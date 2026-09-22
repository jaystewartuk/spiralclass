"use server";

import { z } from "zod";
import type { TFunction } from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import {
  addTestimonial as addTestimonialCore,
  clearTestimonialPhoto as clearTestimonialPhotoCore,
  deleteTestimonial as deleteTestimonialCore,
  moveTestimonial as moveTestimonialCore,
  setTestimonialPublished as setTestimonialPublishedCore,
  TESTIMONIAL_BODY_MAX,
  testimonialInputSchema,
  updateTestimonial as updateTestimonialCore,
} from "@/lib/testimonials/store";
import {
  ALLOWED_TESTIMONIAL_PHOTO_TYPES,
  TESTIMONIAL_PHOTO_MAX_BYTES,
  removeTestimonialPhoto,
  uploadTestimonialPhoto,
} from "@/lib/storage/testimonial-photos";
import { prisma } from "@/lib/prisma";
import { revalidateAfterAction } from "@/lib/revalidate";

// Teacher-authored testimonials shown as social proof on the public booking
// page (docs/features/student-acquisition.md, D-24). The CRUD rules live
// in lib/testimonials/store; these actions parse
// the form, scope to the signed-in teacher, and revalidate both the dashboard
// editor and the public page so a published change shows immediately.
//
// Every message below comes from the shared catalog. It used to be a
// `locale === "en" ? english : spanish` ternary per message, which had no third
// branch — so a French teacher, a locale this app has shipped since the catalog
// gained `catalog.fr.ts`, was told "No encontramos ese testimonio." The catalog
// is the only place that knows about every registered locale, and it fails to
// COMPILE when a key is missing one.

export type TestimonialState = { error?: string; ok?: boolean } | undefined;

const idField = z.string().uuid();

async function revalidate(bookingSlug: string) {
  revalidateAfterAction("/dashboard/testimonials");
  revalidateAfterAction(`/b/${bookingSlug}`);
}

// Validates and uploads a testimonial photo from formData. Returns the storage
// path on success, null when no file was submitted, or an error string.
async function handlePhotoUpload(
  teacherId: string,
  testimonialId: string,
  formData: FormData,
  t: TFunction,
): Promise<{ storagePath: string | null; error: string | null }> {
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { storagePath: null, error: null }; // no file — fine
  }
  if (!ALLOWED_TESTIMONIAL_PHOTO_TYPES[file.type]) {
    return { storagePath: null, error: t("web.dashboard.testimonials.errorPhotoType") };
  }
  if (file.size > TESTIMONIAL_PHOTO_MAX_BYTES) {
    return { storagePath: null, error: t("web.dashboard.testimonials.errorPhotoSize") };
  }
  const { storagePath, error } = await uploadTestimonialPhoto(teacherId, testimonialId, file);
  if (error) {
    return { storagePath: null, error: t("web.dashboard.testimonials.errorPhotoUpload") };
  }
  return { storagePath, error: null };
}

// ---------- add ----------

export async function addTestimonial(
  _prev: TestimonialState,
  formData: FormData,
): Promise<TestimonialState> {
  const t = await getT();
  const parsed = testimonialInputSchema.safeParse({
    authorName: formData.get("authorName"),
    authorNote: formData.get("authorNote"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return { error: t("web.dashboard.testimonials.errorInvalid", { max: TESTIMONIAL_BODY_MAX }) };
  }

  const teacher = await requireOnboardedTeacher();

  // Create the row first (we need the id for the storage path).
  const created = await addTestimonialCore(teacher.id, parsed.data);

  // Upload photo if provided. If upload fails, delete the just-created row and
  // surface the error so the user can retry cleanly.
  const { storagePath, error: photoError } = await handlePhotoUpload(
    teacher.id,
    created.id,
    formData,
    t,
  );
  if (photoError) {
    await deleteTestimonialCore(teacher.id, created.id).catch(() => {});
    return { error: photoError };
  }

  // Attach the photo path if we got one.
  if (storagePath) {
    await prisma.testimonial.updateMany({
      where: { id: created.id, teacherId: teacher.id },
      data: { photoPath: storagePath },
    });
  }

  await revalidate(teacher.bookingSlug);
  return { ok: true };
}

// ---------- update ----------

const updateSchema = testimonialInputSchema.extend({ id: idField });

export async function updateTestimonial(
  _prev: TestimonialState,
  formData: FormData,
): Promise<TestimonialState> {
  const t = await getT();
  const parsed = updateSchema.safeParse({
    id: formData.get("id"),
    authorName: formData.get("authorName"),
    authorNote: formData.get("authorNote"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return { error: t("web.dashboard.testimonials.errorInvalid", { max: TESTIMONIAL_BODY_MAX }) };
  }

  const { id, ...input } = parsed.data;
  const teacher = await requireOnboardedTeacher();

  // Fetch the existing row so we can clean up the old photo if a new one is uploaded.
  const existing = await prisma.testimonial.findFirst({
    where: { id, teacherId: teacher.id },
    select: { photoPath: true },
  });
  if (!existing) {
    return { error: t("web.dashboard.testimonials.errorNotFound") };
  }

  // Handle optional photo replacement.
  const { storagePath: newPhotoPath, error: photoError } = await handlePhotoUpload(
    teacher.id,
    id,
    formData,
    t,
  );
  if (photoError) return { error: photoError };

  // If a new photo was uploaded, remove the old one (best-effort).
  if (newPhotoPath && existing.photoPath && existing.photoPath !== newPhotoPath) {
    await removeTestimonialPhoto(existing.photoPath);
  }

  // Pass the new path (or undefined to leave unchanged) through to the store.
  const ok = await updateTestimonialCore(
    teacher.id,
    id,
    input,
    newPhotoPath !== null ? newPhotoPath : undefined,
  );
  if (!ok) {
    return { error: t("web.dashboard.testimonials.errorNotFound") };
  }

  await revalidate(teacher.bookingSlug);
  return { ok: true };
}

// ---------- publish toggle ----------

const publishSchema = z.object({ id: idField, published: z.coerce.boolean() });

export async function setTestimonialPublished(
  _prev: TestimonialState,
  formData: FormData,
): Promise<TestimonialState> {
  const t = await getT();
  const parsed = publishSchema.safeParse({
    id: formData.get("id"),
    published: formData.get("published"),
  });
  if (!parsed.success) {
    return { error: t("web.dashboard.testimonials.errorInvalidData") };
  }

  const teacher = await requireOnboardedTeacher();
  const ok = await setTestimonialPublishedCore(teacher.id, parsed.data.id, parsed.data.published);
  if (!ok) {
    return { error: t("web.dashboard.testimonials.errorNotFound") };
  }

  await revalidate(teacher.bookingSlug);
  return { ok: true };
}

// ---------- reorder ----------

// `sortOrder` is what the public page orders by, so this is the teacher's only
// control over which quote a visitor reads first. One step at a time rather
// than drag-and-drop: the arrows work on a phone, from a keyboard and with a
// screen reader, and the list is short enough that a step is never far.
const moveSchema = z.object({ id: idField, direction: z.enum(["up", "down"]) });

export async function moveTestimonial(
  _prev: TestimonialState,
  formData: FormData,
): Promise<TestimonialState> {
  const t = await getT();
  const parsed = moveSchema.safeParse({
    id: formData.get("id"),
    direction: formData.get("direction"),
  });
  if (!parsed.success) {
    return { error: t("web.dashboard.testimonials.errorInvalidData") };
  }

  const teacher = await requireOnboardedTeacher();
  const moved = await moveTestimonialCore(teacher.id, parsed.data.id, parsed.data.direction);

  // Already at that end of the list — the arrow that sent this is disabled in
  // the UI, so a request that arrives anyway (a stale page, a double tap) is a
  // no-op rather than an error to show her.
  if (!moved) return { ok: true };

  await revalidate(teacher.bookingSlug);
  return { ok: true };
}

// ---------- delete ----------

const deleteSchema = z.object({ id: idField });

export async function deleteTestimonial(
  _prev: TestimonialState,
  formData: FormData,
): Promise<TestimonialState> {
  const t = await getT();
  const parsed = deleteSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) {
    return { error: t("web.dashboard.testimonials.errorInvalidData") };
  }

  const teacher = await requireOnboardedTeacher();

  // Remove the photo from storage before deleting the row.
  const existing = await prisma.testimonial.findFirst({
    where: { id: parsed.data.id, teacherId: teacher.id },
    select: { photoPath: true },
  });
  if (existing?.photoPath) {
    await removeTestimonialPhoto(existing.photoPath);
  }

  const ok = await deleteTestimonialCore(teacher.id, parsed.data.id);
  if (!ok) {
    return { error: t("web.dashboard.testimonials.errorNotFound") };
  }

  await revalidate(teacher.bookingSlug);
  return { ok: true };
}

// ---------- delete photo only ----------

export async function deleteTestimonialPhoto(
  _prev: TestimonialState,
  formData: FormData,
): Promise<TestimonialState> {
  const t = await getT();
  const parsed = deleteSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) {
    return { error: t("web.dashboard.testimonials.errorInvalidData") };
  }

  const teacher = await requireOnboardedTeacher();

  const existing = await prisma.testimonial.findFirst({
    where: { id: parsed.data.id, teacherId: teacher.id },
    select: { photoPath: true },
  });
  if (!existing) {
    return { error: t("web.dashboard.testimonials.errorNotFound") };
  }
  if (existing.photoPath) {
    await removeTestimonialPhoto(existing.photoPath);
  }

  const ok = await clearTestimonialPhotoCore(teacher.id, parsed.data.id);
  if (!ok) {
    return { error: t("web.dashboard.testimonials.errorNotFound") };
  }

  await revalidate(teacher.bookingSlug);
  return { ok: true };
}
