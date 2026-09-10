import { requireStudent } from "@/lib/auth";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible } from "@/components/ui/collapsible";
import { studentComplianceIds } from "@/lib/students/identity";
import { pendingStudentDeletionRequest } from "@/lib/account-deletion/requests";
import { serverEnv, hasGoogleAuthCreds } from "@/lib/env";
import { getLinkedGoogleAccount } from "@/lib/auth/google-link-status";
import { prisma } from "@/lib/prisma";
import { studentPhotoUrl } from "@/lib/storage/student-photo";
import { languageOptions } from "@spiralclass/shared";
import { getOrCreateStudentFeedToken } from "@/lib/calendar/feed-token";
import { CalendarSyncPanel } from "@/components/calendar/calendar-sync-panel";
import { regenerateStudentFeedAction } from "@/app/actions/calendar-feed";
import { COMMON_TIMEZONES } from "@/app/(app)/onboarding/timezone/timezones";
import { MyDetailsForm } from "@/components/account/my-details-form";
import { NativeLanguageForm } from "@/components/account/native-language-form";
import { CaptionsConsentToggle } from "@/components/account/captions-consent-toggle";
import { getCaptionsConsentForStudent } from "@/lib/captions/consent-writes";
import { EmailChangeForm } from "@/components/account/email-change-form";
import { GoogleConnectionCard } from "@/components/account/google-connection-card";
import { NotificationPrefsForm } from "@/components/account/notification-prefs-form";
import { WebPushToggle } from "@/components/account/web-push-toggle";
import { PwaInstallRow } from "@/components/account/pwa-install-row";
import { ReadingControls } from "@/components/reading-controls";
import { getReadingPreferences } from "@/lib/reading-server";
import { AccountDeletionForm } from "@/app/(app)/settings/account/account-deletion-form";
import { NotificationSchedule } from "@/components/notification-schedule";
import { AccountIdentityCard } from "./identity-card";
import { SectionNav, type AccountSection } from "./section-nav";
import { SettingsRow, SettingsSection } from "./settings-section";
import {
  updateMyContactInfoAction,
  requestEmailChangeAction,
  verifyEmailChangeAction,
} from "@/app/actions/student-contact";
import { saveNotificationPrefsAction } from "@/app/actions/notification-prefs";
import { coerceNotificationPrefs } from "@/lib/notifications/preferences";
import { getPreferredLocale, getT } from "@/lib/i18n";

// docs/security.md. Student-facing account page. Built from the
// shared account forms in components/account/* — the same My details / Sign-in
// email / Calendar sync / Notifications / Download / Delete controls the teacher
// page renders, with student-specific data and the student server actions.
//
// STRUCTURE, because it is the thing that was wrong here. The student gets on
// ONE page what the teacher gets as six (`/settings/account`,
// `/settings/notifications`, `/settings/calendar`, …), and it was laid out as
// twelve free-standing cards in a flat stack — every title the same size as the
// page's own `<h1>`, nothing grouped, nothing saying what was further down. So
// the twelve are now six titled sections (settings-section.tsx), the page opens
// by saying whose account it is (identity-card.tsx), and a jump nav
// (section-nav.tsx) gives the six the addressability separate pages would have.
// The controls themselves are unchanged.

export default async function StudentAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ correo?: string; google?: string }>;
}) {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const t = await getT();
  // ?correo=actualizado is set by the auth callback's email_change redirect.
  // ?google=linked|error is set by the Google reconnect flow's callback.
  const { correo, google } = await searchParams;
  const googleConfigured = hasGoogleAuthCreds();
  const studentPrefs = coerceNotificationPrefs(student.notificationPrefs);

  const [
    pending,
    feedToken,
    pushTokenCount,
    photoUrl,
    captionsConsented,
    linkedGoogleAccount,
    reading,
  ] = await Promise.all([
    // A deletion request fans out across the whole identity set (one row
    // per same-email Student row) — surface it whichever row carries it.
    studentComplianceIds(student).then((ids) => pendingStudentDeletionRequest(ids)),
    getOrCreateStudentFeedToken(student.id),
    // A browser Web Push subscription is the `push` channel's only transport
    // and its only one.
    prisma.webPushSubscription.count({
      where: { recipientType: "student", recipientId: student.id, revokedAt: null },
    }),
    studentPhotoUrl(student.photoPath),
    getCaptionsConsentForStudent(prisma, student),
    googleConfigured && student.authUserId
      ? getLinkedGoogleAccount(student.authUserId)
      : Promise.resolve(null),
    getReadingPreferences(),
  ]);
  const feedUrl = `${serverEnv().APP_URL.replace(/\/$/, "")}/api/calendar/feed/${feedToken}.ics`;

  // The identity block repeats two settled values whose CONTROLS live further
  // down — the point of a summary is that you can read it without going there.
  const languageLabel = languageOptions(locale, { captionsOnly: true }).find(
    (language) => language.code === student.nativeLanguage,
  )?.label;
  const identityMeta = [student.timezone, languageLabel].filter((value): value is string =>
    Boolean(value),
  );

  // One list, feeding the nav and the sections alike, so a section can never
  // appear in one and not the other.
  const sections: AccountSection[] = [
    { id: "profile", label: t("web.myClasses.account.sections.profile") },
    { id: "sign-in", label: t("web.myClasses.account.sections.signIn") },
    { id: "preferences", label: t("web.myClasses.account.sections.preferences") },
    { id: "notifications", label: t("web.myClasses.account.notifications.title") },
    { id: "calendar", label: t("web.myClasses.account.sections.calendar") },
    { id: "data", label: t("web.myClasses.account.sections.data") },
  ];

  return (
    <PageShell width="reading">
      <PageHeader
        title={t("web.myClasses.account.title")}
        description={t("web.myClasses.account.subtitle")}
      />

      {google === "linked" && (
        <Alert role="status" variant="success">
          {t("web.settings.account.googleLinkedBanner")}
        </Alert>
      )}
      {google === "error" && (
        <Alert role="alert" variant="destructive">
          {t("web.settings.account.googleLinkErrorBanner")}
        </Alert>
      )}

      <AccountIdentityCard
        name={student.name}
        email={student.email}
        photoUrl={photoUrl}
        meta={identityMeta}
      />

      <SectionNav sections={sections} label={t("web.myClasses.account.sectionNav.label")} />

      <SettingsSection
        id="profile"
        title={t("web.myClasses.account.sections.profile")}
        description={t("web.myClasses.account.myDetails.description")}
      >
        <SettingsRow>
          <MyDetailsForm
            action={updateMyContactInfoAction}
            initialName={student.name}
            initialPhone={student.phoneE164}
            initialTimezone={student.timezone}
            timezoneOptions={COMMON_TIMEZONES}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="sign-in"
        title={t("web.myClasses.account.sections.signIn")}
        description={t("web.myClasses.account.sections.signInDescription")}
      >
        <SettingsRow
          title={t("web.myClasses.account.signInEmail.title")}
          description={t("web.myClasses.account.signInEmail.description")}
        >
          <EmailChangeForm
            action={requestEmailChangeAction}
            verifyAction={verifyEmailChangeAction}
            currentEmail={student.email}
            justChanged={correo === "actualizado"}
            hasGoogleLinked={Boolean(linkedGoogleAccount)}
          />
        </SettingsRow>

        {googleConfigured && (
          <SettingsRow
            title={t("web.settings.account.googleTitle")}
            description={t("web.settings.account.googleDescription")}
          >
            <GoogleConnectionCard
              linked={Boolean(linkedGoogleAccount)}
              redirectTo="/my-classes/account"
            />
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection
        id="preferences"
        title={t("web.myClasses.account.sections.preferences")}
        description={t("web.myClasses.account.sections.preferencesDescription")}
      >
        <SettingsRow
          title={t("web.myClasses.account.nativeLanguage.title")}
          description={t("web.myClasses.account.nativeLanguage.description")}
        >
          <NativeLanguageForm initialLanguage={student.nativeLanguage} />
        </SettingsRow>

        <SettingsRow
          title={t("web.myClasses.account.captionsConsent.title")}
          description={t("web.myClasses.account.captionsConsent.description")}
        >
          <CaptionsConsentToggle initialConsented={captionsConsented} />
        </SettingsRow>

        {/* Reading preferences (D-140) sit with the student deliberately: a
            teacher configures the product, a student READS in it. */}
        <SettingsRow title={t("web.reading.title")} description={t("web.reading.intro")}>
          <ReadingControls initial={reading} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="notifications"
        title={t("web.myClasses.account.notifications.title")}
        description={t("web.myClasses.account.notifications.description")}
      >
        <SettingsRow>
          <NotificationPrefsForm
            role="student"
            action={saveNotificationPrefsAction}
            initialPrefs={studentPrefs}
            channels={{
              emailOptIn: student.emailOptIn,
              pushOptIn: student.pushOptIn,
              hasPushDevice: pushTokenCount > 0,
            }}
            // Browser push for this device — same control the teacher settings
            // page renders, feeding the same `push` channel. It sits inside the
            // form now, under the push opt-in it unblocks, rather than in a row
            // of its own below the thing that points at it.
            deviceSlot={
              <div className="space-y-4">
                <WebPushToggle />
                {/* Renders nothing unless this browser has a real one-tap
                    install to offer. It sits under the push control rather
                    than in a banner because installing is what makes push
                    survive a closed browser — the reader is already here
                    for that. */}
                <PwaInstallRow />
              </div>
            }
          />
        </SettingsRow>

        {/* Reference, not a setting: eleven rows of "what we send and when",
            which as an always-open card was the longest thing on the page and
            the last thing anyone came here to do. */}
        <SettingsRow>
          <Collapsible title={t("web.myClasses.account.schedule.title")} defaultOpen={false}>
            <p className="text-muted-foreground text-sm">
              {t("web.myClasses.account.schedule.description")}
            </p>
            <NotificationSchedule audience="student" prefs={studentPrefs} />
          </Collapsible>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="calendar"
        title={t("web.myClasses.account.sections.calendar")}
        description={t("web.myClasses.account.calendarSync.description")}
      >
        <SettingsRow>
          <CalendarSyncPanel feedUrl={feedUrl} regenerateAction={regenerateStudentFeedAction} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="data"
        title={t("web.myClasses.account.sections.data")}
        description={t("web.myClasses.account.sections.dataDescription")}
      >
        <SettingsRow
          title={t("web.dataExportCard.title")}
          description={t("web.dataExportCard.description", {
            included: t("web.dataExportCard.includedStudent"),
          })}
        >
          {/* `asChild`, so the download link carries the same height, focus ring
              and press state as every other control here rather than a
              hand-rolled copy of the button's classes. */}
          <Button asChild variant="outline">
            <a href="/api/account/export" download>
              {t("web.dataExportCard.downloadButton")}
            </a>
          </Button>
        </SettingsRow>

        <SettingsRow
          tone="danger"
          title={t("web.deleteAccountCard.title")}
          description={t("web.deleteAccountCard.description")}
        >
          <AccountDeletionForm
            subjectType="student"
            pending={
              pending ? { id: pending.id, scheduledFor: pending.scheduledFor.toISOString() } : null
            }
          />
        </SettingsRow>
      </SettingsSection>
    </PageShell>
  );
}
