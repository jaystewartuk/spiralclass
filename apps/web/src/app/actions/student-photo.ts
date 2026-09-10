"use server";

import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  putStudentPhoto,
  removeStudentPhoto,
} from "@/lib/storage/student-photo";
import { logger } from "@/lib/logger";
import { revalidateAfterAction } from "@/lib/revalidate";

const log = logger({ surface: "student-photo" });

export type ProfileState = { error?: string; ok?: boolean } | undefined;

// Uploads the student's profile photo to the private `student-photos` bucket
// (one object per student; re-upload replaces in place) and stores the key.
// Service-role upload — same pattern as saveTeacherPhotoAction; ownership is
// already established by requireStudent and the path is scoped to the
// student id.
export async function saveStudentPhotoAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const en = locale === "en";

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

  const { path, error: upErr } = await putStudentPhoto(student.id, file);
  if (upErr) {
    log.warn("upload failed", { error: upErr });
    return {
      error: en ? `We couldn't upload the image: ${upErr}` : `No pudimos subir la imagen: ${upErr}`,
    };
  }

  await prisma.student.update({
    where: { id: student.id },
    data: { photoPath: path },
  });

  revalidateAfterAction("/my-classes/account");
  return { ok: true };
}

// Removes the student's profile photo (clears the pointer and deletes the
// object best-effort).
export async function removeStudentPhotoAction(): Promise<ProfileState> {
  const student = await requireStudent();
  if (student.photoPath) {
    await removeStudentPhoto(student.photoPath);
  }
  await prisma.student.update({
    where: { id: student.id },
    data: { photoPath: null },
  });
  revalidateAfterAction("/my-classes/account");
  return { ok: true };
}
