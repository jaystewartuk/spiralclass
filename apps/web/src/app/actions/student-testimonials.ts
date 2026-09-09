"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { testimonialEligibility } from "@/lib/testimonials/eligibility";
import { TESTIMONIAL_BODY_MAX } from "@/lib/testimonials/limits";
import {
  deleteStudentTestimonial,
  studentTestimonialInputSchema,
  upsertStudentTestimonial,
} from "@/lib/testimonials/store";

// The student's own half of the testimonial feature — the half that makes the
// verified badge mean anything.
//
// Everything here is scoped by the SIGNED-IN student's identity set, never by
// an id in the form: the teacher id arrives from the page, is checked against
// the student's own pairings, and the Student row that ends up on the
// testimonial is the one the platform resolved, not one the request named. That
// is what stops the write path from being a nicer-looking version of the
// problem it fixes.

export type StudentTestimonialState = { error?: string; ok?: boolean } | undefined;

const teacherIdField = z.string().uuid();

export async function saveStudentTestimonial(
  _prev: StudentTestimonialState,
  formData: FormData,
): Promise<StudentTestimonialState> {
  const en = (await getPreferredLocale()) === "en";
  const parsed = z
    .object({ teacherId: teacherIdField })
    .merge(studentTestimonialInputSchema)
    .safeParse({
      teacherId: formData.get("teacherId"),
      body: formData.get("body"),
    });
  if (!parsed.success) {
    return {
      error: en
        ? `Write a few words about your classes (under ${TESTIMONIAL_BODY_MAX} characters).`
        : `Escribe unas palabras sobre tus clases (máximo ${TESTIMONIAL_BODY_MAX} caracteres).`,
    };
  }

  const student = await requireStudent();
  const { teacherId, body } = parsed.data;

  const eligibility = await testimonialEligibility(student, teacherId);
  if (!eligibility.studentId || !eligibility.eligible) {
    // One message for "not your teacher" and "no completed classes yet" alike.
    // Distinguishing them would let a signed-in stranger probe which teachers a
    // given account studies with, and neither case is actionable in a way the
    // other wording would help with.
    return {
      error: en
        ? "You can write a testimonial once you've finished a class with this teacher."
        : "Puedes escribir un testimonio cuando hayas terminado una clase con esta profesora.",
    };
  }

  // The displayed name comes from the roster row, not the form.
  const row = await prisma.student.findUnique({
    where: { id: eligibility.studentId },
    select: { name: true },
  });
  const authorName = row?.name?.trim();
  if (!authorName) {
    return {
      error: en
        ? "Add your name in your account settings first, so your teacher can credit you."
        : "Primero agrega tu nombre en la configuración de tu cuenta, para que tu profesora pueda acreditarte.",
    };
  }

  await upsertStudentTestimonial(teacherId, eligibility.studentId, authorName, { body });

  await revalidateFor(teacherId);
  return { ok: true };
}

export async function removeStudentTestimonial(
  _prev: StudentTestimonialState,
  formData: FormData,
): Promise<StudentTestimonialState> {
  const en = (await getPreferredLocale()) === "en";
  const parsed = z
    .object({ teacherId: teacherIdField })
    .safeParse({ teacherId: formData.get("teacherId") });
  if (!parsed.success) {
    return { error: en ? "Invalid data." : "Datos inválidos." };
  }

  const student = await requireStudent();
  const eligibility = await testimonialEligibility(student, parsed.data.teacherId);
  if (!eligibility.studentId) {
    return { error: en ? "We couldn't find that teacher." : "No encontramos a esa profesora." };
  }

  // Note the missing eligibility check: withdrawing is always allowed, even for
  // a student whose pairing has since been archived. Consent to being quoted in
  // public has to be revocable on the same terms it was given, or the badge is
  // describing something other than consent.
  await deleteStudentTestimonial(parsed.data.teacherId, eligibility.studentId);

  await revalidateFor(parsed.data.teacherId);
  return { ok: true };
}

// The student's own page, the teacher's editor, and the public booking page all
// render this row. The last of the three is the one that matters and the one
// easiest to forget, so the slug lookup lives here rather than at each caller.
async function revalidateFor(teacherId: string) {
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { bookingSlug: true },
  });
  revalidatePath(`/my-classes/teachers/${teacherId}`);
  revalidatePath("/dashboard/testimonials");
  if (teacher?.bookingSlug) revalidatePath(`/b/${teacher.bookingSlug}`);
}
