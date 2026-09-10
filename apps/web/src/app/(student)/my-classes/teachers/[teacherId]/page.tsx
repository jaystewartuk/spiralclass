import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, ExternalLink, MessageCircle, MessageSquare } from "lucide-react";
import { whatsAppChatUrl } from "@spiralclass/shared";
import { requireStudent } from "@/lib/auth";
import { getT, getPreferredLocale } from "@/lib/i18n";
import { bookingWhen, sameWallClock, zoneNow } from "@/lib/date-display";
import { languageDisplayName } from "@/lib/language-name";
import {
  countStudentTeachers,
  getNextClassWithTeacher,
  getStudentTeacherProfile,
} from "@/lib/students/teacher-profile";
import { BackLink } from "@/components/back-link";
import { CopyLinkButton } from "@/components/copy-link-button";
import { TeacherAvatar } from "@/components/teacher-identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { PageShell } from "@/components/ui/page-shell";
import { LocalClocks, type ClockParty } from "./local-clocks";
import { testimonialEligibility } from "@/lib/testimonials/eligibility";
import { findStudentTestimonial } from "@/lib/testimonials/store";
import { StudentTestimonialForm } from "./testimonial-form";

// The student's view of one of their teachers: who she is, what time it is
// where she is, and every way to reach her — in that order, because that is
// the order the questions arrive in.
//
// Two earlier defects are worth naming so they are not reintroduced. The page
// printed `teachers.timezone` verbatim ("America/Mexico_City"), the same
// machine-identifier-as-copy bug `timezoneCityLabel` exists to fix elsewhere;
// and its only call to action sent an ALREADY ENROLLED student to the public
// sales funnel, while the in-app message thread she actually wants was not
// linked from here at all.

/** Everything the page and its metadata both need, resolved once. `cache` is
 * keyed on the teacherId string, so `generateMetadata` and the render share a
 * single pass rather than doubling every query. */
const loadProfile = cache(async (teacherId: string) => {
  const student = await requireStudent();
  const teacher = await getStudentTeacherProfile(student, teacherId);
  if (!teacher) return null;
  // Independent of one another and of the profile above; the profile carries
  // the authorization predicate, and these two are already scoped by the same
  // identity set, so nothing here widens what a student can read.
  const [teacherCount, nextClass] = await Promise.all([
    countStudentTeachers(student),
    getNextClassWithTeacher(student, teacherId),
  ]);
  return { student, teacher, teacherCount, nextClass };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}): Promise<Metadata> {
  const { teacherId } = await params;
  const loaded = await loadProfile(teacherId);
  const t = await getT();
  // A student with several teachers ends up with several of these tabs open;
  // the name is the only thing that tells them apart.
  return { title: loaded ? loaded.teacher.name : t("web.myTeachers.title") };
}

export default async function StudentTeacherProfilePage({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}) {
  const { teacherId } = await params;
  const loaded = await loadProfile(teacherId);
  if (!loaded) notFound();
  const { student, teacher, teacherCount, nextClass } = loaded;

  // Their own testimonial for this teacher, and whether they may write one
  // yet (D-151). Both are cheap, and both are needed to choose between the
  // form, the text they already wrote, and the "after your first class" note.
  const eligibility = await testimonialEligibility(student, teacher.id);
  const existingTestimonial = eligibility.studentId
    ? await findStudentTestimonial(teacher.id, eligibility.studentId)
    : null;

  const t = await getT();
  const locale = await getPreferredLocale();

  const subject = languageDisplayName(teacher.targetLanguage, locale);
  // Only worth saying when it differs from the subject — "Teaches Spanish /
  // Classes in Spanish" is one fact printed twice.
  const instructionLanguage =
    teacher.teachingLanguage && teacher.teachingLanguage !== teacher.targetLanguage
      ? languageDisplayName(teacher.teachingLanguage, locale)
      : null;

  // ── The two clocks ───────────────────────────────────────────────────────
  // A student whose zone we have never captured gets one clock; a student who
  // happens to share the teacher's wall clock gets one clock and a sentence
  // saying so, rather than two identical faces labelled differently.
  const now = new Date();
  const studentTz = student.timezone;
  const teacherClock = zoneNow(now, teacher.timezone, locale);
  const studentClock = studentTz ? zoneNow(now, studentTz, locale) : null;
  const sharesTeacherClock = studentClock !== null && sameWallClock(studentClock, teacherClock);
  const clocks: ClockParty[] = [
    {
      label: t("web.myTeachers.theirTime", { name: teacher.name }),
      tz: teacher.timezone,
      initial: teacherClock,
    },
    ...(studentTz && studentClock && !sharesTeacherClock
      ? [{ label: t("web.dualZone.yourTime"), tz: studentTz, initial: studentClock }]
      : []),
  ];

  const whatsappUrl = teacher.publicWhatsappE164
    ? whatsAppChatUrl(teacher.publicWhatsappE164)
    : null;

  // Viewer-primary, other-secondary — the dual-zone display standard every
  // class-time surface in the product follows. A student who has never had a
  // timezone captured falls back to the teacher's, matching the portal home.
  const nextClassWhen = nextClass
    ? bookingWhen(
        nextClass.scheduledStart,
        studentTz ?? teacher.timezone,
        { tz: teacher.timezone, label: teacher.name },
        locale,
        t,
      )
    : null;

  // With one teacher, "My teachers" redirects straight back here — so back has
  // to mean the classes list instead, or it bounces the student in place.
  const parent =
    teacherCount > 1
      ? { href: "/my-classes/teachers", label: t("web.myTeachers.backToTeachers") }
      : { href: "/my-classes", label: t("web.myClasses.title") };

  return (
    <PageShell width="reading">
      <BackLink href={parent.href} label={parent.label} />

      <Card>
        <CardHeader className="gap-4">
          {/* The name sits BESIDE the avatar and the headline below both. On a
              phone an 80px avatar and its gap leave about 230px, and a headline
              is a sentence — it wants the column, not the remainder. */}
          <div className="flex items-center gap-4">
            <TeacherAvatar name={teacher.name} photoUrl={teacher.photoUrl} size={80} />
            <Heading level={1} as="h1" className="min-w-0 break-words">
              {teacher.name}
            </Heading>
          </div>

          {teacher.headline && <p className="text-muted-foreground text-sm">{teacher.headline}</p>}

          {(subject || instructionLanguage) && (
            <div className="flex flex-wrap gap-2">
              {subject && (
                <Badge variant="secondary">
                  {t("web.myTeachers.teachesLanguage", { language: subject })}
                </Badge>
              )}
              {instructionLanguage && (
                <Badge variant="outline">
                  {t("web.myTeachers.classesInLanguage", { language: instructionLanguage })}
                </Badge>
              )}
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-5">
          <section
            aria-labelledby="teacher-right-now"
            className="border-border bg-muted rounded-md border p-4"
          >
            <Heading
              level={4}
              as="h2"
              id="teacher-right-now"
              className="text-muted-foreground mb-3 text-sm"
            >
              {t("web.myTeachers.rightNow")}
            </Heading>
            <LocalClocks parties={clocks} locale={locale} />
            {sharesTeacherClock && (
              <p className="text-muted-foreground mt-3 text-sm">
                {t("web.myTeachers.sameTimeAsYou")}
              </p>
            )}
          </section>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild className="sm:flex-1">
              <Link href={`/my-classes/messages/${teacher.id}`}>
                <MessageSquare className="h-4 w-4" aria-hidden />
                {t("web.myTeachers.sendMessage")}
              </Link>
            </Button>
            {whatsappUrl && (
              <Button asChild variant="secondary" className="sm:flex-1">
                <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
                  <MessageCircle className="h-4 w-4" aria-hidden />
                  {t("common.chatOnWhatsApp")}
                  <span className="sr-only">{`, ${t("common.opensInNewTab")}`}</span>
                </a>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {nextClass && nextClassWhen && (
        <Card>
          <Link
            href={`/my-classes/${nextClass.id}`}
            className="hover:bg-muted/50 flex items-center gap-3 rounded-lg p-6 transition-colors"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-muted-foreground text-sm">{t("web.myTeachers.nextClass")}</p>
              <p className="font-semibold">{nextClassWhen.when}</p>
              <p className="text-muted-foreground text-sm">{nextClassWhen.whenSecondary}</p>
            </div>
            <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" aria-hidden />
          </Link>
        </Card>
      )}

      {teacher.bio && (
        <Card>
          <CardHeader className="pb-3">
            <Heading level={3} as="h2">
              {t("web.myTeachers.about")}
            </Heading>
          </CardHeader>
          <CardContent>
            {/* The bio is authored in a textarea; without this its paragraph
                breaks collapse into one wall of text. */}
            <p className="whitespace-pre-line">{teacher.bio}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <Heading level={3} as="h2">
            {t("web.myTeachers.contactDetails")}
          </Heading>
        </CardHeader>
        <CardContent>
          <dl className="divide-border divide-y">
            <ContactRow
              label={t("web.myTeachers.email")}
              value={teacher.email}
              href={`mailto:${teacher.email}`}
              copyLabel={t("web.myTeachers.copyEmail")}
              copiedLabel={t("web.myTeachers.emailCopied")}
            />
            {teacher.phoneE164 && (
              <ContactRow
                label={t("web.myTeachers.phone")}
                // E.164 verbatim rather than prettified: the national grouping
                // can only be guessed from the calling code, and a number a
                // student is about to dial or paste is the wrong place to
                // guess. splitE164 says as much about its own certainty.
                value={teacher.phoneE164}
                href={`tel:${teacher.phoneE164}`}
                copyLabel={t("web.myTeachers.copyPhone")}
                copiedLabel={t("web.myTeachers.phoneCopied")}
              />
            )}
          </dl>
        </CardContent>
      </Card>

      {/* D-151: a testimonial the teacher cannot write. It sits after the
          contact details because it is something the student gives rather than
          something they came here to look up. */}
      <Card>
        <CardHeader className="pb-3">
          <Heading level={3} as="h2">
            {t("web.myTeachers.testimonial.heading")}
          </Heading>
        </CardHeader>
        <CardContent>
          {eligibility.eligible ? (
            <StudentTestimonialForm
              teacherId={teacher.id}
              teacherName={teacher.name}
              existingBody={existingTestimonial?.body ?? null}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("web.myTeachers.testimonial.notYet", { name: teacher.name })}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Button asChild variant="outline" className="w-full">
          <a href={`/b/${teacher.bookingSlug}`} target="_blank" rel="noopener noreferrer">
            {t("web.myTeachers.viewBookingPage")}
            <ExternalLink className="h-4 w-4" aria-hidden />
            <span className="sr-only">{`, ${t("common.opensInNewTab")}`}</span>
          </a>
        </Button>
        <p className="text-muted-foreground text-sm">{t("web.myTeachers.bookingPageHint")}</p>
      </div>
    </PageShell>
  );
}

/**
 * One labelled contact detail: a linked value and a copy control.
 *
 * `div > dt > dd` rather than a flex row of siblings, because a `dl` may only
 * contain `dt`/`dd` pairs (or `div`s that do) — the copy button has to live
 * INSIDE the `dd`, not beside it, or the list stops being a description list
 * to everything that reads the tree.
 */
function ContactRow({
  label,
  value,
  href,
  copyLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  href: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="flex items-center gap-2">
        {/* `min-h-11` because this is a discrete tap target in a list, not a
            link inside a sentence — D-140's 44px minimum applies. */}
        <a
          href={href}
          className="inline-flex min-h-11 min-w-0 flex-1 items-center truncate rounded-sm hover:underline"
        >
          {value}
        </a>
        <CopyLinkButton value={value} label={copyLabel} toastMessage={copiedLabel} iconOnly />
      </dd>
    </div>
  );
}
