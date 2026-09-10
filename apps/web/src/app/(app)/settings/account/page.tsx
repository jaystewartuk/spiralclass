import Link from "next/link";
import { requireTeacher } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionNav, type NavSection } from "@/components/ui/section-nav";
import { SettingRow, SettingsSection } from "@/components/ui/settings-section";
import { ToggleSetting } from "@/components/ui/toggle-setting";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { hasGoogleAuthCreds } from "@/lib/env";
import { getLinkedGoogleAccount } from "@/lib/auth/google-link-status";
import { countryOptions } from "@spiralclass/shared";
import { COMMON_TIMEZONES } from "@/app/(app)/onboarding/timezone/timezones";
import { AccountAvatar } from "@/components/account-avatar";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";
import { MyDetailsForm } from "@/components/account/my-details-form";
import { CountryForm } from "./country-form";
import { EmailChangeForm } from "@/components/account/email-change-form";
import { GoogleConnectionCard } from "@/components/account/google-connection-card";
import { DataExportButton, dataExportDescription } from "@/components/account/data-export-card";
import { ReadingPreferences } from "@/components/account/reading-card";
import { AccountDeletionForm } from "./account-deletion-form";
import { recordingEnabled } from "@/lib/video/recording";
import {
  updateMyTeacherContactAction,
  requestTeacherEmailChangeAction,
  verifyTeacherEmailChangeAction,
} from "@/app/actions/teacher-account";
import {
  saveAutoRecordClassesAction,
  saveAutoSurfaceLevelMaterialsAction,
} from "@/app/actions/profile";

// docs/security.md. Teacher-facing account page.
//
// Six NAMED GROUPS, not ten peer cards. The page used to be a flat stack of
// `Card`s whose titles all rendered at the page heading's own size, so nothing
// on it was more or less important than anything else and the reader had to
// infer the grouping. It now says what the groups are (`SettingsSection`), the
// type descends page → section → row, and a sticky `SectionNav` makes the
// column navigable rather than merely long.
//
// NOTIFICATIONS LIVE ON /settings/notifications, and only there. This page
// rendered a second copy of `NotificationPrefsForm` that was strictly worse:
// it counted push reachability from a transport that no longer exists
// so a teacher whose browser push works perfectly saw
// the push opt-in DISABLED here and enabled on the notifications page. One
// setting cannot have two pages that disagree about it; the dedicated page is
// the one that also carries the browser-push toggle and the schedule, so it
// wins and this page links to it with a read-only summary of the channels.
//
// Booking-page content (headline/bio/photo) lives on /settings/booking-page;
// calendar sync and billing have their own pages too.

export default async function AccountSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ correo?: string; google?: string }>;
}) {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  // ?correo=actualizado is set by the auth callback's email_change redirect.
  // ?google=linked|error is set by the Google reconnect flow's callback/
  // errorCallback (GoogleConnectionCard) landing back on this page.
  const { correo, google } = await searchParams;
  const googleConfigured = hasGoogleAuthCreds();
  const showRecording = recordingEnabled();

  const [pending, linkedGoogleAccount, pushDevices] = await Promise.all([
    prisma.accountDeletionRequest.findFirst({
      where: { subjectType: "teacher", subjectId: teacher.id, status: "pending" },
    }),
    googleConfigured ? getLinkedGoogleAccount(teacher.id) : Promise.resolve(null),
    // A browser Web Push subscription is the `push` channel's only transport
    // and its only one.
    prisma.webPushSubscription.count({
      where: { recipientType: "teacher", recipientId: teacher.id, revokedAt: null },
    }),
  ]);

  // "Push on" has to mean push will actually reach her, which takes the opt-in
  // AND somewhere to send it. The opt-in alone would render "Push on" for a
  // teacher who has never registered a device and never sees one.
  const pushReachable = teacher.pushOptIn && pushDevices > 0;

  const memberSince = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: teacher.timezone,
  }).format(teacher.createdAt);

  // Every section renders unconditionally — the two optional ROWS (Google,
  // recording) sit inside sections that have another row regardless — so the
  // quick-jump bar is a fixed list and can never point at a missing anchor.
  const sections: NavSection[] = [
    { id: "profile", label: t("web.settings.account.sections.profile.title") },
    { id: "sign-in", label: t("web.settings.account.sections.signIn.title") },
    { id: "classes", label: t("web.settings.account.sections.classes.title") },
    { id: "preferences", label: t("web.settings.account.sections.preferences.title") },
    { id: "data", label: t("web.settings.account.sections.data.title") },
    { id: "delete", label: t("web.deleteAccountCard.title") },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("web.settings.account.title")}
        description={t("web.settings.account.subtitle")}
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

      {/* Which account is this? The header's badge answers it in 28px of
          chrome; on the page that edits the account it is worth stating
          plainly, next to the one fact nothing below can tell her — how long
          she has been here. */}
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <AccountAvatar
          name={teacher.name}
          email={teacher.email}
          photoUrl={teacherPhotoPublicUrl(teacher.photoPath, teacher.updatedAt.getTime())}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{teacher.name}</p>
          <p className="text-muted-foreground truncate text-sm">{teacher.email}</p>
        </div>
        <p className="text-muted-foreground text-sm">
          {t("web.settings.account.memberSince", { date: memberSince })}
        </p>
      </Card>

      <SectionNav sections={sections} ariaLabel={t("web.settings.account.sectionNavLabel")} />

      {/* Wider gaps BETWEEN groups than between the rows inside one, so the
          grouping is legible from the spacing alone. */}
      <div className="space-y-10">
        <SettingsSection
          id="profile"
          title={t("web.settings.account.sections.profile.title")}
          description={t("web.settings.account.sections.profile.description")}
        >
          <SettingRow
            title={t("web.settings.account.myDetailsTitle")}
            description={t("web.settings.account.myDetailsDescription")}
          >
            <MyDetailsForm
              action={updateMyTeacherContactAction}
              initialName={teacher.name}
              initialPhone={teacher.phoneE164}
              initialPhoneCountry={teacher.country}
              initialTimezone={teacher.timezone}
              timezoneOptions={COMMON_TIMEZONES}
            />
          </SettingRow>

          <SettingRow
            title={t("web.settings.account.countryTitle")}
            description={t("web.settings.account.countryDescription")}
          >
            <CountryForm
              initialCountry={teacher.country}
              countries={countryOptions(locale)}
              locked={Boolean(teacher.stripeAccountId)}
            />
          </SettingRow>
        </SettingsSection>

        <SettingsSection
          id="sign-in"
          title={t("web.settings.account.sections.signIn.title")}
          description={t("web.settings.account.sections.signIn.description")}
        >
          <SettingRow
            title={t("web.settings.account.signInEmailTitle")}
            description={t("web.settings.account.signInEmailDescription")}
          >
            <EmailChangeForm
              action={requestTeacherEmailChangeAction}
              verifyAction={verifyTeacherEmailChangeAction}
              currentEmail={teacher.email}
              justChanged={correo === "actualizado"}
              hasGoogleLinked={Boolean(linkedGoogleAccount)}
            />
          </SettingRow>

          {googleConfigured && (
            <SettingRow
              title={t("web.settings.account.googleTitle")}
              description={t("web.settings.account.googleDescription")}
            >
              <GoogleConnectionCard
                linked={Boolean(linkedGoogleAccount)}
                redirectTo="/settings/account"
              />
            </SettingRow>
          )}
        </SettingsSection>

        <SettingsSection
          id="classes"
          title={t("web.settings.account.sections.classes.title")}
          description={t("web.settings.account.sections.classes.description")}
        >
          <SettingRow
            title={t("web.settings.account.teachingTitle")}
            description={t("web.settings.account.teachingDescription")}
          >
            <ToggleSetting
              name="autoSurfaceLevelMaterials"
              action={saveAutoSurfaceLevelMaterialsAction}
              initialEnabled={teacher.autoSurfaceLevelMaterials}
              label={t("web.settings.autoSurfaceMaterials.label")}
              hint={t("web.settings.autoSurfaceMaterials.hint")}
              savingLabel={t("web.settings.saving")}
              savedLabel={t("web.settings.targetLanguage.savedMessage")}
            />
          </SettingRow>

          {/* Its own row rather than a second checkbox under "Class materials":
              recording needs room to say what the student sees and what it does
              not decide. Absent entirely when recording isn't configured for
              this environment, the same rule the in-call Record control
              follows. */}
          {showRecording && (
            <SettingRow
              title={t("web.settings.account.recordingTitle")}
              description={t("web.settings.account.recordingDescription")}
            >
              <ToggleSetting
                name="autoRecordClasses"
                action={saveAutoRecordClassesAction}
                initialEnabled={teacher.autoRecordClasses}
                label={t("web.settings.autoRecordClasses.label")}
                hint={t("web.settings.autoRecordClasses.hint")}
                savingLabel={t("web.settings.saving")}
                savedLabel={t("web.settings.targetLanguage.savedMessage")}
              />
            </SettingRow>
          )}
        </SettingsSection>

        <SettingsSection
          id="preferences"
          title={t("web.settings.account.sections.preferences.title")}
          description={t("web.settings.account.sections.preferences.description")}
        >
          <SettingRow title={t("web.reading.title")} description={t("web.reading.intro")}>
            <ReadingPreferences />
          </SettingRow>

          <SettingRow
            title={t("web.settings.account.notificationsTitle")}
            description={t("web.settings.account.notificationsDescription")}
            action={
              <Button asChild variant="outline">
                <Link href="/settings/notifications">
                  {t("web.settings.account.notificationsManage")}
                </Link>
              </Button>
            }
          >
            {/* Read-only, so it cannot disagree with the page that owns it.
                Each badge carries the state as a WORD — colour alone is not a
                status (D-140). */}
            <div className="flex flex-wrap gap-2">
              <Badge variant={teacher.emailOptIn ? "success" : "secondary"}>
                {t(
                  teacher.emailOptIn
                    ? "web.settings.account.channels.emailOn"
                    : "web.settings.account.channels.emailOff",
                )}
              </Badge>
              <Badge variant={pushReachable ? "success" : "secondary"}>
                {t(
                  pushReachable
                    ? "web.settings.account.channels.pushOn"
                    : "web.settings.account.channels.pushOff",
                )}
              </Badge>
            </div>
          </SettingRow>
        </SettingsSection>

        <SettingsSection
          id="data"
          title={t("web.settings.account.sections.data.title")}
          description={await dataExportDescription("teacher")}
        >
          <SettingRow>
            <DataExportButton />
          </SettingRow>
        </SettingsSection>

        <SettingsSection
          id="delete"
          tone="danger"
          title={t("web.deleteAccountCard.title")}
          description={t("web.deleteAccountCard.description")}
        >
          <SettingRow>
            <AccountDeletionForm
              subjectType="teacher"
              pending={
                pending
                  ? { id: pending.id, scheduledFor: pending.scheduledFor.toISOString() }
                  : null
              }
            />
          </SettingRow>
        </SettingsSection>
      </div>
    </div>
  );
}
