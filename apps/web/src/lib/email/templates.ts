import { createT, languageCodeToLocale, type AppLocale, type TFunction } from "@spiralclass/shared";
import type { LanguageCode, TemplateName, TemplateVariables } from "@/lib/notifications/templates";
import { renderBrandedEmailHtml, type EmailHtmlContent } from "./html-shell";
import { cancellationPolicyPath } from "@/lib/terms-anchors";

// Email rendering for the 13 notifications, in es + en. The text body
// is the WhatsApp fallback; the html body wraps the same content
// in the brand chrome (see html-shell.ts). URL suffixes are appended to
// APP_URL by the dispatcher before rendering. Confirmation and reminder
// templates have no action URL — the class video call happens on
// WhatsApp (the class detail page) so there's no meeting link to surface.

export type RenderedEmail = {
  subject: string;
  body: string;
  html: string;
};

export type RenderInput<T extends TemplateName> = {
  templateName: T;
  languageCode: LanguageCode;
  variables: TemplateVariables[T];
  // Pre-built absolute URL for the action button (already concatenated from
  // APP_URL + suffix), or null when the template has no action.
  actionUrl: string | null;
  // Pre-built absolute unsubscribe URL (HMAC-signed token under
  // `/r/email-uns/<token>`), appended to the body. Null in tests or when
  // the dispatcher cannot derive a teacher/student pair.
  unsubscribeUrl?: string | null;
  // Pre-built absolute "notification settings" URL (HMAC-signed token under
  // `/r/notif-settings/<token>`), appended to the body. Unlike
  // unsubscribeUrl this is sent on every email — teacher and student alike.
  notificationSettingsUrl?: string | null;
  // Pre-built absolute "Add to calendar" URL (a Google Calendar template
  // link), surfaced as a secondary link on the booking templates. Null when
  // the template has no class to add (most templates) or the data is missing.
  calendarUrl?: string | null;
  // App origin (e.g. "https://spiralclass.com") used to build the email
  // header logo URL. Required for the hosted PNG path; when absent the
  // header falls back to an inline SVG data URI.
  appUrl?: string;
};

type TemplateRender = {
  subject: string;
  textBody: string;
  html: EmailHtmlContent;
};

export function renderEmail<T extends TemplateName>(input: RenderInput<T>): RenderedEmail {
  const t = createT(languageCodeToLocale(input.languageCode));
  const rendered = buildTemplate(input);
  let body = rendered.textBody;
  const footerLines = [
    input.notificationSettingsUrl
      ? notificationSettingsLine(t, input.notificationSettingsUrl)
      : null,
    input.unsubscribeUrl ? footerLine(t, input.unsubscribeUrl) : null,
  ].filter((line): line is string => line !== null);
  if (footerLines.length > 0) {
    body = `${body}\n\n—\n${footerLines.join("\n")}`;
  }
  const html = renderBrandedEmailHtml(rendered.html, {
    languageCode: input.languageCode,
    unsubscribeUrl: input.unsubscribeUrl ?? null,
    notificationSettingsUrl: input.notificationSettingsUrl ?? null,
    appUrl: input.appUrl,
  });
  return { subject: rendered.subject, body, html };
}

function footerLine(t: TFunction, unsubscribeUrl: string): string {
  return t("email.footerLine.text", { unsubscribeUrl });
}

function notificationSettingsLine(t: TFunction, notificationSettingsUrl: string): string {
  return t("email.notificationSettingsLine.text", { notificationSettingsUrl });
}

// Deep link to the cancellation policy on /terms. Recipients could do nothing
// with the internal spec section number these emails used to print, so a
// deduction email cites the policy by name and links here instead. That
// judgement is why no citation survives anywhere a reader can see. Falls back
// to the production
// origin when the dispatcher hasn't wired appUrl (tests).
function cancellationPolicyUrl(appUrl: string | undefined, locale: AppLocale): string {
  const origin = (appUrl ?? "https://spiralclass.com").replace(/\/$/, "");
  return `${origin}${cancellationPolicyPath(locale)}`;
}

// Teacher-mirror note when the student's own notice was suppressed by the
// archived-pairing gate ("dar de baja"). The suppression itself is silent
// by design; the teacher email is where the gap should be visible.
function archivedSuppressionNote(studentName: string, t: TFunction): string {
  return t("email.archivedSuppressionNote.text", { studentName });
}

// The medium line on booking emails. When the dispatcher supplies a call URL
// (via actionUrl — set only when the platform call is available for this
// booking, D-16), the email points the student at the in-class video call with a
// button; otherwise it keeps the original "we meet on WhatsApp" copy. `textLink`
// puts the URL in the plain-text body too, alongside the html cta.
function meetingMedium(
  t: TFunction,
  callUrl: string | null,
): { sentence: string; cta?: { label: string; url: string }; textLink: string } {
  if (callUrl) {
    const label = t("call.studentJoin");
    return {
      sentence: t("email.meetingMedium.sentence"),
      cta: { label, url: callUrl },
      textLink: `\n\n${t("email.labelledValue", { label: label, value: callUrl })}`,
    };
  }
  return {
    sentence: t("email.meetingMedium.sentence2"),
    textLink: "",
  };
}

function buildTemplate<T extends TemplateName>(input: RenderInput<T>): TemplateRender {
  const recipientLocale = languageCodeToLocale(input.languageCode);
  const t = createT(recipientLocale);
  // The action link in a plain-text body, or a marker where the dispatcher had
  // none to give. One value, so every template says the same thing when it is
  // missing; it used to be "(pending)" in some and "(link pending)" in others.
  const actionLink = input.actionUrl ?? t("email.linkPending");
  // "Add to calendar" secondary link, attached to the booking templates when
  // the dispatcher supplies a calendar URL (lib/calendar). No-op otherwise.
  const calLabel = t("web.myClasses.confirmation.addToCalendar");
  const calLine = input.calendarUrl
    ? `\n\n${t("email.labelledValue", { label: calLabel, value: input.calendarUrl })}`
    : "";
  const calLink = input.calendarUrl ? { label: calLabel, url: input.calendarUrl } : undefined;
  // Meeting medium for the booking templates (WhatsApp by default, video call
  // when available). `cta` is undefined when there's no call, so booking emails
  // stay button-less in that case.
  const meet = meetingMedium(t, input.actionUrl);
  switch (input.templateName) {
    case "booking_confirmation": {
      const v = input.variables as TemplateVariables["booking_confirmation"];
      return {
        subject: t("email.bookingConfirmation.subject", { teacherName: v.teacherName }),
        textBody: t("email.bookingConfirmation.textBody", {
          teacherName: v.teacherName,
          classDateTime: v.classDateTime,
          classesRemaining: v.classesRemaining,
          sentence: meet.sentence,
          textLink: meet.textLink,
          calLine,
        }),
        html: {
          preheader: t("email.bookingConfirmation.htmlPreheader", {
            classDateTime: v.classDateTime,
            classesRemaining: v.classesRemaining,
          }),
          heading: t("push.bookingConfirmation.title"),
          paragraphs: [
            t("email.bookingConfirmation.htmlParagraphs0", {
              teacherName: v.teacherName,
              classDateTime: v.classDateTime,
              classesRemaining: v.classesRemaining,
            }),
            meet.sentence,
          ],
          cta: meet.cta,
          secondaryLink: calLink,
        },
      };
    }
    case "reminder_24h": {
      const v = input.variables as TemplateVariables["reminder_24h"];
      return {
        subject: t("email.reminder24h.subject", { teacherName: v.teacherName }),
        textBody: t("email.reminder24h.textBody", {
          teacherName: v.teacherName,
          classDateTime: v.classDateTime,
          sentence: meet.sentence,
          textLink: meet.textLink,
          calLine,
        }),
        html: {
          preheader: t("email.reminder24h.htmlPreheader", { classDateTime: v.classDateTime }),
          heading: t("email.reminder24h.htmlHeading"),
          paragraphs: [
            t("email.reminder24h.htmlParagraphs0", {
              teacherName: v.teacherName,
              classDateTime: v.classDateTime,
            }),
            meet.sentence,
          ],
          cta: meet.cta,
          secondaryLink: calLink,
        },
      };
    }
    case "reminder_1h": {
      const v = input.variables as TemplateVariables["reminder_1h"];
      // 1h embeds the medium inline ("…, por WhatsApp."). With a call link we
      // split it into a plain greeting + the call sentence + button; without
      // one we keep the original single-sentence copy verbatim.
      const greeting1h = input.actionUrl
        ? t("email.reminder1h.greeting1h", {
            teacherName: v.teacherName,
            classDateTime: v.classDateTime,
          })
        : t("email.reminder1h.greeting1h2", {
            teacherName: v.teacherName,
            classDateTime: v.classDateTime,
          });
      const tail1h = input.actionUrl ? ` ${meet.sentence}${meet.textLink}` : "";
      return {
        subject: t("email.reminder1h.subject", { teacherName: v.teacherName }),
        textBody: `${greeting1h}${tail1h}${calLine}`,
        html: {
          preheader: t("email.reminder1h.htmlPreheader", { classDateTime: v.classDateTime }),
          heading: t("email.reminder1h.htmlHeading"),
          paragraphs: input.actionUrl ? [greeting1h, meet.sentence] : [greeting1h],
          cta: meet.cta,
          secondaryLink: calLink,
        },
      };
    }
    case "reminder_15m": {
      const v = input.variables as TemplateVariables["reminder_15m"];
      const greeting5m = input.actionUrl
        ? t("email.reminder15m.greeting5m", {
            teacherName: v.teacherName,
            classDateTime: v.classDateTime,
          })
        : t("email.reminder15m.greeting5m2", {
            teacherName: v.teacherName,
            classDateTime: v.classDateTime,
          });
      const tail5m = input.actionUrl ? ` ${meet.sentence}${meet.textLink}` : "";
      return {
        subject: t("email.reminder15m.subject", { teacherName: v.teacherName }),
        textBody: `${greeting5m}${tail5m}`,
        html: {
          preheader: t("email.reminder15m.htmlPreheader", { classDateTime: v.classDateTime }),
          heading: t("email.reminder15m.htmlHeading"),
          paragraphs: input.actionUrl ? [greeting5m, meet.sentence] : [greeting5m],
          cta: meet.cta,
        },
      };
    }
    // Teacher-recipient reminders. Teacher-voiced copy that names the student.
    // Unlike the student reminders these only surface the meeting line/button
    // when a real video-call link is available — no stale "on WhatsApp" copy.
    case "reminder_24h_teacher": {
      const v = input.variables as TemplateVariables["reminder_24h_teacher"];
      const meetParas = input.actionUrl ? [meet.sentence] : [];
      const meetTail = input.actionUrl ? `\n\n${meet.sentence}${meet.textLink}` : "";
      return {
        subject: t("email.reminder24hTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.reminder24hTeacher.textBody", {
          studentName: v.studentName,
          classDateTime: v.classDateTime,
          meetTail,
          calLine,
        }),
        html: {
          preheader: t("email.reminder24h.htmlPreheader", { classDateTime: v.classDateTime }),
          heading: t("email.reminder24h.htmlHeading"),
          paragraphs: [
            t("email.reminder24hTeacher.htmlParagraphs0", {
              studentName: v.studentName,
              classDateTime: v.classDateTime,
            }),
            ...meetParas,
          ],
          cta: meet.cta,
          secondaryLink: calLink,
        },
      };
    }
    case "reminder_1h_teacher": {
      const v = input.variables as TemplateVariables["reminder_1h_teacher"];
      const meetParas = input.actionUrl ? [meet.sentence] : [];
      const meetTail = input.actionUrl ? `\n\n${meet.sentence}${meet.textLink}` : "";
      return {
        subject: t("email.reminder1hTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.reminder1hTeacher.textBody", {
          studentName: v.studentName,
          classDateTime: v.classDateTime,
          meetTail,
          calLine,
        }),
        html: {
          preheader: t("email.reminder1h.htmlPreheader", { classDateTime: v.classDateTime }),
          heading: t("email.reminder1h.htmlHeading"),
          paragraphs: [
            t("email.reminder1hTeacher.htmlParagraphs0", {
              studentName: v.studentName,
              classDateTime: v.classDateTime,
            }),
            ...meetParas,
          ],
          cta: meet.cta,
          secondaryLink: calLink,
        },
      };
    }
    case "reminder_15m_teacher": {
      const v = input.variables as TemplateVariables["reminder_15m_teacher"];
      const meetParas = input.actionUrl ? [meet.sentence] : [];
      const meetTail = input.actionUrl ? `\n\n${meet.sentence}${meet.textLink}` : "";
      return {
        subject: t("email.reminder15mTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.reminder15mTeacher.textBody", {
          studentName: v.studentName,
          classDateTime: v.classDateTime,
          meetTail,
        }),
        html: {
          preheader: t("email.reminder15m.htmlPreheader", { classDateTime: v.classDateTime }),
          heading: t("email.reminder15m.htmlHeading"),
          paragraphs: [
            t("email.reminder15mTeacher.htmlParagraphs0", {
              studentName: v.studentName,
              classDateTime: v.classDateTime,
            }),
            ...meetParas,
          ],
          cta: meet.cta,
        },
      };
    }
    case "cancel_lt24h": {
      const v = input.variables as TemplateVariables["cancel_lt24h"];
      const policyUrl = cancellationPolicyUrl(input.appUrl, recipientLocale);
      return {
        subject: t("email.cancelLt24h.subject", { teacherName: v.teacherName }),
        textBody: t("email.cancelLt24h.textBody", {
          teacherName: v.teacherName,
          originalDateTime: v.originalDateTime,
          policyUrl,
        }),
        html: {
          preheader: t("email.cancelLt24h.htmlPreheader", { originalDateTime: v.originalDateTime }),
          heading: t("email.cancelLt24h.htmlHeading"),
          paragraphs: [
            t("email.cancelLt24h.htmlParagraphs0", {
              teacherName: v.teacherName,
              originalDateTime: v.originalDateTime,
            }),
          ],
          cta: { label: t("email.cancelLt24h.htmlCtaLabel"), url: policyUrl },
        },
      };
    }
    case "cancel_gte24h_with_reschedule": {
      const v = input.variables as TemplateVariables["cancel_gte24h_with_reschedule"];
      return {
        subject: t("email.cancelGte24hWithReschedule.subject", { teacherName: v.teacherName }),
        textBody: t("email.cancelGte24hWithReschedule.textBody", {
          teacherName: v.teacherName,
          originalDateTime: v.originalDateTime,
          actionLink,
        }),
        html: {
          preheader: t("email.cancelGte24hWithReschedule.htmlPreheader"),
          heading: t("email.cancelGte24hWithReschedule.htmlPreheader"),
          paragraphs: [
            t("email.cancelGte24hWithReschedule.htmlParagraphs0", {
              teacherName: v.teacherName,
              originalDateTime: v.originalDateTime,
            }),
          ],
          cta: input.actionUrl
            ? { label: t("email.cancelGte24hWithReschedule.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "teacher_cancel": {
      const v = input.variables as TemplateVariables["teacher_cancel"];
      return {
        subject: t("email.teacherCancel.subject", { teacherName: v.teacherName }),
        textBody: t("email.teacherCancel.textBody", {
          teacherName: v.teacherName,
          originalDateTime: v.originalDateTime,
          actionLink,
        }),
        html: {
          preheader: t("email.teacherCancel.htmlPreheader"),
          heading: t("email.teacherCancel.htmlHeading"),
          paragraphs: [
            t("email.teacherCancel.htmlParagraphs0", {
              teacherName: v.teacherName,
              originalDateTime: v.originalDateTime,
            }),
            t("email.teacherCancel.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.cancelGte24hWithReschedule.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "reschedule_confirm": {
      const v = input.variables as TemplateVariables["reschedule_confirm"];
      return {
        subject: t("email.rescheduleConfirm.subject", { teacherName: v.teacherName }),
        textBody: t("email.rescheduleConfirm.textBody", {
          teacherName: v.teacherName,
          oldDateTime: v.oldDateTime,
          newDateTime: v.newDateTime,
        }),
        html: {
          preheader: t("email.rescheduleConfirm.htmlPreheader", { newDateTime: v.newDateTime }),
          heading: t("push.rescheduleConfirm.title"),
          paragraphs: [
            t("email.rescheduleConfirm.htmlParagraphs0", {
              teacherName: v.teacherName,
              oldDateTime: v.oldDateTime,
              newDateTime: v.newDateTime,
            }),
            t("email.meetingMedium.sentence2"),
          ],
        },
      };
    }
    case "payment_received": {
      const v = input.variables as TemplateVariables["payment_received"];
      return {
        subject: t("email.paymentReceived.subject", { teacherName: v.teacherName }),
        textBody: t("email.paymentReceived.textBody", {
          teacherName: v.teacherName,
          packageName: v.packageName,
          amount: v.amount,
          actionLink,
        }),
        html: {
          preheader: `${v.packageName} · ${v.amount}`,
          heading: t("push.paymentReceived.title"),
          paragraphs: [
            t("email.paymentReceived.htmlParagraphs0", {
              teacherName: v.teacherName,
              packageName: v.packageName,
              amount: v.amount,
            }),
            t("email.paymentReceived.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.paymentReceived.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "magic_link": {
      const v = input.variables as TemplateVariables["magic_link"];
      return {
        subject: t("email.magicLink.subject", { teacherName: v.teacherName }),
        textBody: t("email.magicLink.textBody", {
          teacherName: v.teacherName,
          expiryMinutes: v.expiryMinutes,
          actionLink,
        }),
        html: {
          preheader: t("email.magicLink.htmlPreheader", { expiryMinutes: v.expiryMinutes }),
          heading: t("email.magicLink.htmlHeading"),
          paragraphs: [
            t("email.magicLink.htmlParagraphs0", {
              teacherName: v.teacherName,
              expiryMinutes: v.expiryMinutes,
            }),
          ],
          cta: input.actionUrl
            ? { label: t("email.magicLink.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "materials_send": {
      const v = input.variables as TemplateVariables["materials_send"];
      return {
        subject: t("email.materialsSend.subject", { teacherName: v.teacherName }),
        textBody: t("email.materialsSend.textBody", {
          teacherName: v.teacherName,
          classDateTime: v.classDateTime,
          actionLink,
        }),
        html: {
          preheader: t("email.materialsSend.htmlPreheader", { classDateTime: v.classDateTime }),
          heading: t("email.materialsSend.htmlHeading"),
          paragraphs: [
            t("email.materialsSend.htmlParagraphs0", {
              teacherName: v.teacherName,
              classDateTime: v.classDateTime,
            }),
          ],
          cta: input.actionUrl
            ? { label: t("email.materialsSend.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "wise_marked_sent_student": {
      const v = input.variables as TemplateVariables["wise_marked_sent_student"];
      return {
        subject: t("email.wiseMarkedSentStudent.subject"),
        textBody: t("email.wiseMarkedSentStudent.textBody", {
          teacherName: v.teacherName,
          wiseReference: v.wiseReference,
          packageName: v.packageName,
        }),
        html: {
          preheader: t("email.wiseMarkedSentStudent.htmlPreheader", {
            wiseReference: v.wiseReference,
            packageName: v.packageName,
          }),
          heading: t("email.wiseMarkedSentStudent.subject"),
          paragraphs: [
            t("email.wiseMarkedSentStudent.htmlParagraphs0", {
              teacherName: v.teacherName,
              wiseReference: v.wiseReference,
              packageName: v.packageName,
            }),
            t("email.wiseMarkedSentStudent.htmlParagraphs1"),
          ],
        },
      };
    }
    case "payment_received_teacher": {
      const v = input.variables as TemplateVariables["payment_received_teacher"];
      return {
        subject: t("email.paymentReceivedTeacher.subject", {
          studentName: v.studentName,
          packageName: v.packageName,
        }),
        textBody: t("email.paymentReceivedTeacher.textBody", {
          teacherName: v.teacherName,
          studentName: v.studentName,
          packageName: v.packageName,
          amount: v.amount,
          actionLink,
        }),
        html: {
          preheader: `${v.studentName} · ${v.packageName} · ${v.amount}`,
          heading: t("push.paymentReceivedTeacher.title"),
          paragraphs: [
            t("email.paymentReceivedTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              packageName: v.packageName,
              amount: v.amount,
            }),
            t("email.paymentReceivedTeacher.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.paymentReceivedTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "payment_pending_teacher": {
      const v = input.variables as TemplateVariables["payment_pending_teacher"];
      return {
        subject: t("email.paymentPendingTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.paymentPendingTeacher.textBody", {
          teacherName: v.teacherName,
          studentName: v.studentName,
          packageName: v.packageName,
          amount: v.amount,
          wiseReference: v.wiseReference,
          actionLink,
        }),
        html: {
          preheader: `${v.studentName} · ${v.amount} · ${v.wiseReference}`,
          heading: t("email.paymentPendingTeacher.htmlHeading"),
          paragraphs: [
            t("email.paymentPendingTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              packageName: v.packageName,
              amount: v.amount,
            }),
            t("email.paymentPendingTeacher.htmlParagraphs1", { wiseReference: v.wiseReference }),
            t("email.paymentPendingTeacher.htmlParagraphs2"),
          ],
          cta: input.actionUrl
            ? { label: t("email.paymentPendingTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "payment_marked_sent_teacher": {
      const v = input.variables as TemplateVariables["payment_marked_sent_teacher"];
      return {
        subject: t("email.paymentMarkedSentTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.paymentMarkedSentTeacher.textBody", {
          teacherName: v.teacherName,
          studentName: v.studentName,
          amount: v.amount,
          packageName: v.packageName,
          wiseReference: v.wiseReference,
          actionLink,
        }),
        html: {
          preheader: `${v.studentName} · ${v.amount} · ${v.wiseReference}`,
          heading: t("email.paymentMarkedSentTeacher.htmlHeading", { studentName: v.studentName }),
          paragraphs: [
            t("email.paymentMarkedSentTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              amount: v.amount,
              packageName: v.packageName,
            }),
            t("email.paymentPendingTeacher.htmlParagraphs1", { wiseReference: v.wiseReference }),
            t("email.paymentMarkedSentTeacher.htmlParagraphs2"),
          ],
          cta: input.actionUrl
            ? { label: t("email.paymentMarkedSentTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "wise_confirm_reminder_teacher": {
      const v = input.variables as TemplateVariables["wise_confirm_reminder_teacher"];
      return {
        subject: t("email.wiseConfirmReminderTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.wiseConfirmReminderTeacher.textBody", {
          teacherName: v.teacherName,
          studentName: v.studentName,
          amount: v.amount,
          packageName: v.packageName,
          wiseReference: v.wiseReference,
          actionLink,
        }),
        html: {
          preheader: t("email.wiseConfirmReminderTeacher.htmlPreheader", {
            studentName: v.studentName,
            amount: v.amount,
          }),
          heading: t("email.wiseConfirmReminderTeacher.htmlHeading"),
          paragraphs: [
            t("email.wiseConfirmReminderTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              amount: v.amount,
              packageName: v.packageName,
            }),
            t("email.paymentPendingTeacher.htmlParagraphs1", { wiseReference: v.wiseReference }),
            t("email.wiseConfirmReminderTeacher.htmlParagraphs2"),
          ],
          cta: input.actionUrl
            ? { label: t("email.paymentPendingTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "lesson_insights_review_teacher": {
      const v = input.variables as TemplateVariables["lesson_insights_review_teacher"];
      return {
        subject: t("email.lessonInsightsReviewTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.lessonInsightsReviewTeacher.textBody", {
          teacherName: v.teacherName,
          studentName: v.studentName,
          actionLink,
        }),
        html: {
          preheader: t("email.lessonInsightsReviewTeacher.htmlPreheader", {
            studentName: v.studentName,
          }),
          heading: t("email.lessonInsightsReviewTeacher.htmlHeading"),
          paragraphs: [
            t("email.lessonInsightsReviewTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
            }),
            t("email.lessonInsightsReviewTeacher.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.lessonInsightsReviewTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "student_acquisition_plan_teacher": {
      const v = input.variables as TemplateVariables["student_acquisition_plan_teacher"];
      const firstAction = v.firstAction || t("email.studentAcquisitionPlanTeacher.firstAction");
      return {
        subject: t("email.studentAcquisitionPlanTeacher.subject", { count: v.actionCount }),
        textBody: t("email.studentAcquisitionPlanTeacher.textBody", {
          teacherName: v.teacherName,
          count: v.actionCount,
          minutes: v.minutes,
          firstAction,
          actionLink,
        }),
        html: {
          preheader: t("email.studentAcquisitionPlanTeacher.htmlPreheader"),
          heading: t("email.studentAcquisitionPlanTeacher.htmlHeading"),
          paragraphs: [
            t("email.studentAcquisitionPlanTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              count: v.actionCount,
              minutes: v.minutes,
            }),
            t("email.studentAcquisitionPlanTeacher.htmlParagraphs1", { firstAction }),
          ],
          cta: input.actionUrl
            ? { label: t("email.studentAcquisitionPlanTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "facebook_groups_nudge_teacher": {
      const v = input.variables as TemplateVariables["facebook_groups_nudge_teacher"];
      const groups =
        v.groupCount > 0
          ? t("email.facebookGroupsNudgeTeacher.groupsCount", { count: v.groupCount })
          : t("email.facebookGroupsNudgeTeacher.groups2");
      return {
        subject: t("email.facebookGroupsNudgeTeacher.subject"),
        textBody: t("email.facebookGroupsNudgeTeacher.textBody", {
          teacherName: v.teacherName,
          groups,
          actionLink,
        }),
        html: {
          preheader: t("email.facebookGroupsNudgeTeacher.htmlPreheader"),
          heading: t("push.facebookGroupsNudgeTeacher.title"),
          paragraphs: [
            t("email.facebookGroupsNudgeTeacher.htmlParagraphs0", { teacherName: v.teacherName }),
            t("email.facebookGroupsNudgeTeacher.htmlParagraphs1", { groups }),
          ],
          cta: input.actionUrl
            ? { label: t("email.facebookGroupsNudgeTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "payment_failed_student": {
      const v = input.variables as TemplateVariables["payment_failed_student"];
      return {
        subject: t("email.paymentFailedStudent.subject", { teacherName: v.teacherName }),
        textBody: t("email.paymentFailedStudent.textBody", {
          teacherName: v.teacherName,
          packageName: v.packageName,
          actionLink,
        }),
        html: {
          preheader: t("email.paymentFailedStudent.htmlPreheader"),
          heading: t("push.paymentFailedStudent.title"),
          paragraphs: [
            t("email.paymentFailedStudent.htmlParagraphs0", {
              teacherName: v.teacherName,
              packageName: v.packageName,
            }),
            t("email.paymentFailedStudent.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.paymentFailedStudent.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "refund_issued_student": {
      const v = input.variables as TemplateVariables["refund_issued_student"];
      return {
        subject: t("email.refundIssuedStudent.subject", { teacherName: v.teacherName }),
        textBody: t("email.refundIssuedStudent.textBody", {
          teacherName: v.teacherName,
          amount: v.amount,
          packageName: v.packageName,
        }),
        html: {
          preheader: t("email.refundIssuedStudent.htmlPreheader", { amount: v.amount }),
          heading: t("push.refundIssuedStudent.title"),
          paragraphs: [
            t("email.refundIssuedStudent.htmlParagraphs0", {
              teacherName: v.teacherName,
              amount: v.amount,
              packageName: v.packageName,
            }),
            t("email.refundIssuedStudent.htmlParagraphs1"),
          ],
        },
      };
    }
    case "refund_issued_teacher": {
      const v = input.variables as TemplateVariables["refund_issued_teacher"];
      return {
        subject: t("email.refundIssuedTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.refundIssuedTeacher.textBody", {
          teacherName: v.teacherName,
          amount: v.amount,
          studentName: v.studentName,
          packageName: v.packageName,
          actionLink,
        }),
        html: {
          preheader: `${v.studentName} · ${v.amount}`,
          heading: t("push.refundIssuedStudent.title"),
          paragraphs: [
            t("email.refundIssuedTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              amount: v.amount,
              studentName: v.studentName,
              packageName: v.packageName,
            }),
            t("email.refundIssuedTeacher.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.refundIssuedTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    // Lost chargeback. Deliberately NOT worded as a refund: the money did not
    // go back voluntarily, and the student's classes are gone rather than
    // returned. Neither version accuses anybody of anything — a chargeback is
    // raised with a card issuer, its outcome is the issuer's, and a genuine
    // billing mix-up looks identical from here.
    case "dispute_lost_student": {
      const v = input.variables as TemplateVariables["dispute_lost_student"];
      return {
        subject: t("email.disputeLostStudent.subject", { teacherName: v.teacherName }),
        textBody: t("email.disputeLostStudent.textBody", {
          teacherName: v.teacherName,
          amount: v.amount,
          packageName: v.packageName,
        }),
        html: {
          preheader: t("email.disputeLostStudent.htmlPreheader", { amount: v.amount }),
          heading: t("push.disputeLostStudent.title"),
          paragraphs: [
            t("email.disputeLostStudent.htmlParagraphs0", {
              teacherName: v.teacherName,
              amount: v.amount,
              packageName: v.packageName,
            }),
            t("email.disputeLostStudent.htmlParagraphs1"),
          ],
        },
      };
    }
    case "dispute_lost_teacher": {
      const v = input.variables as TemplateVariables["dispute_lost_teacher"];
      return {
        subject: t("email.disputeLostTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.disputeLostTeacher.textBody", {
          teacherName: v.teacherName,
          amount: v.amount,
          studentName: v.studentName,
          packageName: v.packageName,
          actionLink,
        }),
        html: {
          preheader: `${v.studentName} · ${v.amount}`,
          heading: t("push.disputeLostTeacher.title"),
          paragraphs: [
            t("email.disputeLostTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              amount: v.amount,
              studentName: v.studentName,
              packageName: v.packageName,
            }),
            t("email.disputeLostTeacher.htmlParagraphs1", { studentName: v.studentName }),
          ],
          cta: input.actionUrl
            ? { label: t("email.refundIssuedTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "stripe_ready_teacher": {
      const v = input.variables as TemplateVariables["stripe_ready_teacher"];
      return {
        subject: t("email.stripeReadyTeacher.subject"),
        textBody: t("email.stripeReadyTeacher.textBody", {
          teacherName: v.teacherName,
          actionLink,
        }),
        html: {
          preheader: t("email.stripeReadyTeacher.htmlPreheader"),
          heading: t("email.stripeReadyTeacher.htmlHeading"),
          paragraphs: [
            t("email.stripeReadyTeacher.htmlParagraphs0", { teacherName: v.teacherName }),
            t("email.stripeReadyTeacher.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.stripeReadyTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "stripe_requirements_teacher": {
      const v = input.variables as TemplateVariables["stripe_requirements_teacher"];
      return {
        subject: t("email.stripeRequirementsTeacher.subject"),
        textBody: t("email.stripeRequirementsTeacher.textBody", {
          teacherName: v.teacherName,
          actionLink,
        }),
        html: {
          preheader: t("email.stripeRequirementsTeacher.htmlPreheader"),
          heading: t("push.stripeRequirementsTeacher.title"),
          paragraphs: [
            t("email.stripeRequirementsTeacher.htmlParagraphs0", { teacherName: v.teacherName }),
            t("email.stripeRequirementsTeacher.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.stripeRequirementsTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "account_disabled_teacher": {
      const v = input.variables as TemplateVariables["account_disabled_teacher"];
      return {
        subject: t("email.accountDisabledTeacher.subject"),
        textBody: t("email.accountDisabledTeacher.textBody", {
          teacherName: v.teacherName,
          reason: v.reason,
        }),
        html: {
          preheader: t("email.accountDisabledTeacher.htmlPreheader"),
          heading: t("email.accountDisabledTeacher.htmlHeading"),
          paragraphs: [
            t("email.accountDisabledTeacher.htmlParagraphs0", { teacherName: v.teacherName }),
            t("email.accountDisabledTeacher.htmlParagraphs1", { reason: v.reason }),
            t("email.accountDisabledTeacher.htmlParagraphs2"),
          ],
        },
      };
    }
    case "booking_created_teacher": {
      const v = input.variables as TemplateVariables["booking_created_teacher"];
      return {
        subject: t("email.bookingCreatedTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.bookingCreatedTeacher.textBody", {
          teacherName: v.teacherName,
          studentName: v.studentName,
          classDateTime: v.classDateTime,
          actionLink,
          calLine,
        }),
        html: {
          preheader: `${v.studentName} · ${v.classDateTime}`,
          heading: t("push.bookingCreatedTeacher.title"),
          paragraphs: [
            t("email.bookingCreatedTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              classDateTime: v.classDateTime,
            }),
          ],
          cta: input.actionUrl
            ? { label: t("email.bookingCreatedTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
          secondaryLink: calLink,
        },
      };
    }
    case "homework_submitted_teacher": {
      const v = input.variables as TemplateVariables["homework_submitted_teacher"];
      const what = v.assignmentTitle
        ? t("email.homeworkSubmittedTeacher.what", { assignmentTitle: v.assignmentTitle })
        : t("email.homeworkSubmittedTeacher.what2");
      return {
        subject: t("email.homeworkSubmittedTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.homeworkSubmittedTeacher.textBody", {
          teacherName: v.teacherName,
          studentName: v.studentName,
          what,
          actionLink,
        }),
        html: {
          preheader: t("email.homeworkSubmittedTeacher.htmlPreheader", {
            studentName: v.studentName,
            title: v.assignmentTitle || t("email.homeworkSubmittedTeacher.defaultTitle"),
          }),
          heading: t("email.homeworkSubmittedTeacher.htmlHeading"),
          paragraphs: [
            t("email.homeworkSubmittedTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              what,
            }),
          ],
          cta: input.actionUrl
            ? { label: t("email.homeworkSubmittedTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "cancel_lt24h_teacher": {
      const v = input.variables as TemplateVariables["cancel_lt24h_teacher"];
      const policyUrl = cancellationPolicyUrl(input.appUrl, recipientLocale);
      const archivedNote = v.studentArchived ? archivedSuppressionNote(v.studentName, t) : null;
      return {
        subject: t("email.cancelLt24hTeacher.subject", { studentName: v.studentName }),
        textBody:
          t("email.cancelLt24hTeacher.textBody", {
            teacherName: v.teacherName,
            studentName: v.studentName,
            originalDateTime: v.originalDateTime,
          }) +
          (archivedNote ? `\n\n${archivedNote}` : "") +
          t("email.cancelLt24hTeacher.textBody2", { policyUrl }),
        html: {
          preheader: `${v.studentName} · ${v.originalDateTime}`,
          heading: t("push.cancelLt24hTeacher.title"),
          paragraphs: [
            t("email.cancelLt24hTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              originalDateTime: v.originalDateTime,
            }),
            t("email.cancelLt24hTeacher.htmlParagraphs1"),
            ...(archivedNote ? [archivedNote] : []),
          ],
          cta: { label: t("email.cancelLt24h.htmlCtaLabel"), url: policyUrl },
        },
      };
    }
    case "cancel_gte24h_teacher": {
      const v = input.variables as TemplateVariables["cancel_gte24h_teacher"];
      const archivedNote = v.studentArchived ? archivedSuppressionNote(v.studentName, t) : null;
      return {
        subject: t("email.cancelGte24hTeacher.subject", { studentName: v.studentName }),
        textBody:
          t("email.cancelGte24hTeacher.textBody", {
            teacherName: v.teacherName,
            studentName: v.studentName,
            originalDateTime: v.originalDateTime,
          }) + (archivedNote ? `\n\n${archivedNote}` : ""),
        html: {
          preheader: `${v.studentName} · ${v.originalDateTime}`,
          heading: t("push.cancelLt24h.title"),
          paragraphs: [
            t("email.cancelGte24hTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              originalDateTime: v.originalDateTime,
            }),
            t("email.cancelGte24hTeacher.htmlParagraphs1"),
            ...(archivedNote ? [archivedNote] : []),
          ],
        },
      };
    }
    case "reschedule_confirm_teacher": {
      const v = input.variables as TemplateVariables["reschedule_confirm_teacher"];
      return {
        subject: t("email.rescheduleConfirmTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.rescheduleConfirmTeacher.textBody", {
          teacherName: v.teacherName,
          studentName: v.studentName,
          oldDateTime: v.oldDateTime,
          newDateTime: v.newDateTime,
        }),
        html: {
          preheader: `${v.studentName} → ${v.newDateTime}`,
          heading: t("push.rescheduleConfirm.title"),
          paragraphs: [
            t("email.rescheduleConfirmTeacher.textBody", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              oldDateTime: v.oldDateTime,
              newDateTime: v.newDateTime,
            }),
          ],
        },
      };
    }
    case "package_expiry_nudge": {
      const v = input.variables as TemplateVariables["package_expiry_nudge"];
      return {
        subject: t("email.packageExpiryNudge.subject", { teacherName: v.teacherName }),
        textBody: t("email.packageExpiryNudge.textBody", {
          teacherName: v.teacherName,
          packageName: v.packageName,
          expiryDate: v.expiryDate,
          classesRemaining: v.classesRemaining,
          actionLink,
        }),
        html: {
          preheader: t("email.packageExpiryNudge.htmlPreheader", {
            expiryDate: v.expiryDate,
            classesRemaining: v.classesRemaining,
          }),
          heading: t("push.packageExpiryNudge.title"),
          paragraphs: [
            t("email.packageExpiryNudge.htmlParagraphs0", {
              teacherName: v.teacherName,
              packageName: v.packageName,
              expiryDate: v.expiryDate,
              classesRemaining: v.classesRemaining,
            }),
            t("email.packageExpiryNudge.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.packageExpiryNudge.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "package_consumed_student": {
      const v = input.variables as TemplateVariables["package_consumed_student"];
      return {
        subject: t("email.packageConsumedStudent.subject", { teacherName: v.teacherName }),
        textBody: t("email.packageConsumedStudent.textBody", {
          teacherName: v.teacherName,
          packageName: v.packageName,
          actionLink,
        }),
        html: {
          preheader: t("email.packageConsumedStudent.htmlPreheader", {
            packageName: v.packageName,
          }),
          heading: t("push.packageConsumedStudent.title"),
          paragraphs: [
            t("email.packageConsumedStudent.htmlParagraphs0", {
              teacherName: v.teacherName,
              packageName: v.packageName,
            }),
            t("email.packageConsumedStudent.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("web.studentHome.buyAnotherPackage"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "package_consumed_teacher": {
      const v = input.variables as TemplateVariables["package_consumed_teacher"];
      // The student only gets their own renewal notice when their
      // `expiry_reminders` category is on (imported / opted-out students get
      // nothing). When it didn't go out, drop the "we already told them" line
      // so the email never claims a send that didn't happen — and lean on the
      // teacher's own WhatsApp follow-up, which is then the only channel.
      const secondLine = v.studentNotified
        ? t("email.packageConsumedTeacher.secondLine")
        : t("email.packageConsumedTeacher.secondLine2");
      return {
        subject: t("email.packageConsumedTeacher.subject", { studentName: v.studentName }),
        textBody: t("email.packageConsumedTeacher.textBody", {
          teacherName: v.teacherName,
          studentName: v.studentName,
          packageName: v.packageName,
          secondLine,
        }),
        html: {
          preheader: t("email.packageConsumedTeacher.htmlPreheader", {
            studentName: v.studentName,
            packageName: v.packageName,
          }),
          heading: t("push.packageConsumedTeacher.title"),
          paragraphs: [
            t("email.packageConsumedTeacher.htmlParagraphs0", {
              teacherName: v.teacherName,
              studentName: v.studentName,
              packageName: v.packageName,
            }),
            secondLine,
          ],
          cta: input.actionUrl
            ? { label: t("email.packageConsumedTeacher.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "no_show_student": {
      const v = input.variables as TemplateVariables["no_show_student"];
      const policyUrl = cancellationPolicyUrl(input.appUrl, recipientLocale);
      return {
        subject: t("email.noShowStudent.subject", { originalDateTime: v.originalDateTime }),
        textBody: t("email.noShowStudent.textBody", {
          teacherName: v.teacherName,
          originalDateTime: v.originalDateTime,
          policyUrl,
        }),
        html: {
          preheader: t("email.noShowStudent.htmlPreheader"),
          heading: t("push.noShowStudent.title"),
          paragraphs: [
            t("email.noShowStudent.htmlParagraphs0", {
              teacherName: v.teacherName,
              originalDateTime: v.originalDateTime,
            }),
            t("email.noShowStudent.htmlParagraphs1"),
          ],
          cta: { label: t("email.cancelLt24h.htmlCtaLabel"), url: policyUrl },
        },
      };
    }
    case "subscription_trial_ending": {
      const v = input.variables as TemplateVariables["subscription_trial_ending"];
      return {
        subject: t("email.subscriptionTrialEnding.subject", { daysRemaining: v.daysRemaining }),
        textBody: t("email.subscriptionTrialEnding.textBody", {
          teacherName: v.teacherName,
          daysRemaining: v.daysRemaining,
          actionLink,
        }),
        html: {
          preheader: t("email.subscriptionTrialEnding.subject", { daysRemaining: v.daysRemaining }),
          heading: t("email.subscriptionTrialEnding.htmlHeading"),
          paragraphs: [
            t("email.subscriptionTrialEnding.htmlParagraphs0", {
              teacherName: v.teacherName,
              daysRemaining: v.daysRemaining,
            }),
            t("email.subscriptionTrialEnding.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("web.subscriptionBanner.choosePlan"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "subscription_payment_succeeded": {
      const v = input.variables as TemplateVariables["subscription_payment_succeeded"];
      return {
        subject: t("email.subscriptionPaymentSucceeded.subject", { amount: v.amount }),
        textBody: t("email.subscriptionPaymentSucceeded.textBody", {
          teacherName: v.teacherName,
          amount: v.amount,
          nextChargeDate: v.nextChargeDate,
          actionLink,
        }),
        html: {
          preheader: t("email.subscriptionPaymentSucceeded.htmlPreheader", { amount: v.amount }),
          heading: t("push.paymentReceived.title"),
          paragraphs: [
            t("email.subscriptionPaymentSucceeded.htmlParagraphs0", {
              teacherName: v.teacherName,
              amount: v.amount,
            }),
            t("email.subscriptionPaymentSucceeded.htmlParagraphs1", {
              nextChargeDate: v.nextChargeDate,
            }),
          ],
          cta: input.actionUrl
            ? { label: t("email.subscriptionPaymentSucceeded.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "subscription_payment_failed": {
      const v = input.variables as TemplateVariables["subscription_payment_failed"];
      return {
        subject: t("email.subscriptionPaymentFailed.subject"),
        textBody: t("email.subscriptionPaymentFailed.textBody", {
          teacherName: v.teacherName,
          graceDays: v.graceDays,
          actionLink,
        }),
        html: {
          preheader: t("push.subscriptionPaymentFailed.title"),
          heading: t("email.subscriptionPaymentFailed.htmlHeading"),
          paragraphs: [
            t("email.subscriptionPaymentFailed.htmlParagraphs0", { teacherName: v.teacherName }),
            t("email.subscriptionPaymentFailed.htmlParagraphs1", { graceDays: v.graceDays }),
          ],
          cta: input.actionUrl
            ? { label: t("email.subscriptionPaymentFailed.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "subscription_canceled": {
      const v = input.variables as TemplateVariables["subscription_canceled"];
      return {
        subject: t("push.subscriptionCanceled.title"),
        textBody: t("email.subscriptionCanceled.textBody", {
          teacherName: v.teacherName,
          actionLink,
        }),
        html: {
          preheader: t("email.subscriptionCanceled.htmlPreheader"),
          heading: t("push.subscriptionCanceled.title"),
          paragraphs: [
            t("email.subscriptionCanceled.htmlParagraphs0", { teacherName: v.teacherName }),
            t("email.subscriptionCanceled.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.subscriptionCanceled.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "subscription_founding_price_locked": {
      const v = input.variables as TemplateVariables["subscription_founding_price_locked"];
      return {
        subject: t("email.subscriptionFoundingPriceLocked.subject", { amount: v.amount }),
        textBody: t("email.subscriptionFoundingPriceLocked.textBody", {
          teacherName: v.teacherName,
          amount: v.amount,
          actionLink,
        }),
        html: {
          preheader: t("email.subscriptionFoundingPriceLocked.htmlPreheader", { amount: v.amount }),
          heading: t("push.subscriptionFoundingPriceLocked.title"),
          paragraphs: [
            t("email.subscriptionFoundingPriceLocked.htmlParagraphs0", {
              teacherName: v.teacherName,
            }),
            t("email.subscriptionFoundingPriceLocked.htmlParagraphs1", { amount: v.amount }),
          ],
          cta: input.actionUrl
            ? { label: t("email.subscriptionPaymentSucceeded.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "library_material_assigned": {
      const v = input.variables as TemplateVariables["library_material_assigned"];
      return {
        subject: t("email.libraryMaterialAssigned.subject", { teacherName: v.teacherName }),
        textBody: t("email.libraryMaterialAssigned.textBody", {
          teacherName: v.teacherName,
          materialLabel: v.materialLabel,
          actionLink,
        }),
        html: {
          preheader: t("email.libraryMaterialAssigned.htmlPreheader", {
            materialLabel: v.materialLabel,
          }),
          heading: t("email.libraryMaterialAssigned.htmlHeading"),
          paragraphs: [
            t("email.libraryMaterialAssigned.htmlParagraphs0", {
              teacherName: v.teacherName,
              materialLabel: v.materialLabel,
            }),
            t("email.libraryMaterialAssigned.htmlParagraphs1"),
          ],
          cta: input.actionUrl
            ? { label: t("email.libraryMaterialAssigned.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "chat_message": {
      const v = input.variables as TemplateVariables["chat_message"];
      return {
        subject: t("push.chatMessage.title", { teacherName: v.teacherName }),
        textBody: t("email.chatMessage.textBody", {
          teacherName: v.teacherName,
          preview: v.preview,
          actionLink,
        }),
        html: {
          preheader: v.preview,
          heading: t("push.chatMessage.title", { teacherName: v.teacherName }),
          paragraphs: [`"${v.preview}"`],
          cta: input.actionUrl
            ? { label: t("email.chatMessage.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "homework_assigned_student": {
      const v = input.variables as TemplateVariables["homework_assigned_student"];
      const what = v.assignmentTitle
        ? `“${v.assignmentTitle}”`
        : t("email.homeworkAssignedStudent.what");
      return {
        subject: t("email.homeworkAssignedStudent.subject", { teacherName: v.teacherName }),
        textBody: t("email.homeworkAssignedStudent.textBody", {
          teacherName: v.teacherName,
          what,
          actionLink,
        }),
        html: {
          preheader: v.assignmentTitle || t("push.homeworkAssignedStudent.title"),
          heading: t("push.homeworkAssignedStudent.title"),
          paragraphs: [
            t("email.homeworkAssignedStudent.htmlParagraphs0", {
              teacherName: v.teacherName,
              what,
            }),
          ],
          cta: input.actionUrl
            ? { label: t("email.homeworkAssignedStudent.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "homework_feedback_available_student": {
      const v = input.variables as TemplateVariables["homework_feedback_available_student"];
      const title = v.assignmentTitle
        ? `"${v.assignmentTitle}"`
        : t("email.homeworkFeedbackAvailableStudent.title");
      if (v.decision === "approved") {
        return {
          subject: t("email.homeworkFeedbackAvailableStudent.subject", {
            teacherName: v.teacherName,
          }),
          textBody: t("email.homeworkFeedbackAvailableStudent.textBody", {
            teacherName: v.teacherName,
            title,
            actionLink,
          }),
          html: {
            preheader: t("push.homeworkFeedbackAvailableStudent.title"),
            heading: t("push.homeworkFeedbackAvailableStudent.title"),
            paragraphs: [
              t("email.homeworkFeedbackAvailableStudent.htmlParagraphs0", {
                teacherName: v.teacherName,
                title,
              }),
            ],
            cta: input.actionUrl
              ? { label: t("email.homeworkAssignedStudent.htmlCtaLabel"), url: input.actionUrl }
              : undefined,
          },
        };
      }
      if (v.decision === "resubmission_requested") {
        return {
          subject: t("email.homeworkFeedbackAvailableStudent.subject2", {
            teacherName: v.teacherName,
          }),
          textBody: t("email.homeworkFeedbackAvailableStudent.textBody2", {
            teacherName: v.teacherName,
            title,
            actionLink,
          }),
          html: {
            preheader: t("push.homeworkFeedbackAvailableStudent.title2"),
            heading: t("push.homeworkFeedbackAvailableStudent.title2"),
            paragraphs: [
              t("email.homeworkFeedbackAvailableStudent.htmlParagraphs02", {
                teacherName: v.teacherName,
                title,
              }),
            ],
            cta: input.actionUrl
              ? { label: t("email.homeworkAssignedStudent.htmlCtaLabel"), url: input.actionUrl }
              : undefined,
          },
        };
      }
      return {
        subject: t("email.homeworkFeedbackAvailableStudent.subject3", {
          teacherName: v.teacherName,
        }),
        textBody: t("email.homeworkFeedbackAvailableStudent.textBody3", {
          teacherName: v.teacherName,
          title,
          actionLink,
        }),
        html: {
          preheader: t("push.homeworkFeedbackAvailableStudent.title3"),
          heading: t("push.homeworkFeedbackAvailableStudent.title3"),
          paragraphs: [
            t("email.homeworkFeedbackAvailableStudent.htmlParagraphs03", {
              teacherName: v.teacherName,
              title,
            }),
          ],
          cta: input.actionUrl
            ? { label: t("email.homeworkAssignedStudent.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "homework_due_soon_student": {
      const v = input.variables as TemplateVariables["homework_due_soon_student"];
      const what = v.assignmentTitle
        ? `"${v.assignmentTitle}"`
        : t("email.homeworkFeedbackAvailableStudent.title");
      return {
        subject: t("push.homeworkDueSoonStudent.title"),
        textBody: t("email.homeworkDueSoonStudent.textBody", {
          what,
          dueDate: v.dueDate,
          actionLink,
        }),
        html: {
          preheader: t("push.homeworkDueSoonStudent.title"),
          heading: t("push.homeworkDueSoonStudent.title"),
          paragraphs: [
            t("email.homeworkDueSoonStudent.htmlParagraphs0", { what, dueDate: v.dueDate }),
          ],
          cta: input.actionUrl
            ? { label: t("email.homeworkAssignedStudent.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "homework_overdue_student": {
      const v = input.variables as TemplateVariables["homework_overdue_student"];
      const what = v.assignmentTitle
        ? `"${v.assignmentTitle}"`
        : t("email.homeworkFeedbackAvailableStudent.title");
      return {
        subject: t("push.homeworkOverdueStudent.title"),
        textBody: t("email.homeworkOverdueStudent.textBody", { what, actionLink }),
        html: {
          preheader: t("push.homeworkOverdueStudent.title"),
          heading: t("push.homeworkOverdueStudent.title"),
          paragraphs: [t("email.homeworkOverdueStudent.htmlParagraphs0", { what })],
          cta: input.actionUrl
            ? { label: t("email.homeworkAssignedStudent.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
    case "chat_message_teacher": {
      const v = input.variables as TemplateVariables["chat_message_teacher"];
      // This one was written in Spanish only, with no English arm at all, so
      // every teacher was told about a student's message in Spanish.
      const heading = t("push.chatMessageTeacher.title", { studentName: v.studentName });
      return {
        subject: heading,
        textBody: t("email.chatMessageTeacher.textBody", {
          studentName: v.studentName,
          preview: v.preview,
          actionLink,
        }),
        html: {
          preheader: v.preview,
          heading,
          paragraphs: [t("email.chatMessageTeacher.quote", { preview: v.preview })],
          cta: input.actionUrl
            ? { label: t("email.chatMessage.htmlCtaLabel"), url: input.actionUrl }
            : undefined,
        },
      };
    }
  }
  const _exhaustive: never = input.templateName;
  throw new Error(`unhandled template ${_exhaustive}`);
}
