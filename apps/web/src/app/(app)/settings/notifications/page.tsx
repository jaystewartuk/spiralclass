import { requireOnboardedTeacher } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { Collapsible } from "@/components/ui/collapsible";
import { SectionNav, type NavSection } from "@/components/ui/section-nav";
import { SettingRow, SettingsSection } from "@/components/ui/settings-section";
import { NotificationSchedule } from "@/components/notification-schedule";
import { NotificationPrefsForm } from "@/components/account/notification-prefs-form";
import { WebPushToggle } from "@/components/account/web-push-toggle";
import { PwaInstallRow } from "@/components/account/pwa-install-row";
import { saveTeacherNotificationPrefsAction } from "@/app/actions/teacher-account";
import { coerceTeacherNotificationPrefs } from "@/lib/notifications/preferences";

// The teacher's notification settings — the ONE page that owns them (see the
// note in /settings/account, which links here rather than rendering a second,
// disagreeing copy).
//
// Three named groups rather than three peer `Card`s. The page was a flat stack
// whose `CardTitle`s render at `text-2xl` — the same 22px as the page's own
// `<h1>` — so the title, "Your preferences", "Notifications you receive" and
// "What your students receive" were four equal shouts and nothing said what
// contained what. It also ran to roughly a thousand pixels of reference list
// with no way to skip past it, which is the exact shape `SectionNav` exists
// for. Both fixes are the ones /settings/account and the student account page
// already made; this page is the last of the three settings screens still
// built the old way.
//
// The ORDER is the dependency order: decide how we reach you and what we send
// (the settings), then read what that means (your schedule), then read what it
// means for someone else (your students'). Only the last is collapsed —
// reference about a third party is the one thing on this page nobody arrives
// here to do.

export default async function NotificationsSettingsPage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();

  // Push-reachability is a browser Web Push subscription — the `push`
  // channel's only transport. Counting the tokens of a retired
  // transport made a recipient look reachable by something that no longer
  // exists.
  const pushCount = await prisma.webPushSubscription.count({
    where: { recipientType: "teacher", recipientId: teacher.id, revokedAt: null },
  });

  const prefs = coerceTeacherNotificationPrefs(teacher.notificationPrefs);

  // Every section renders unconditionally, so no quick-jump entry can point at
  // an anchor that isn't there.
  const sections: NavSection[] = [
    { id: "preferences", label: t("web.settings.notifications.preferencesTitle") },
    { id: "schedule", label: t("web.settings.notifications.youReceiveTitle") },
    { id: "students", label: t("web.settings.notifications.studentsReceiveTitle") },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("web.settings.notifications.title")}
        description={t("web.settings.notifications.subtitle")}
      />

      <SectionNav sections={sections} ariaLabel={t("web.settings.notifications.sectionNavLabel")} />

      {/* Wider gaps BETWEEN groups than between the rows inside one, so the
          grouping is legible from the spacing alone. */}
      <div className="space-y-10">
        <SettingsSection
          id="preferences"
          title={t("web.settings.notifications.preferencesTitle")}
          description={t("web.settings.notifications.preferencesDescription")}
        >
          <SettingRow>
            <NotificationPrefsForm
              role="teacher"
              action={saveTeacherNotificationPrefsAction}
              initialPrefs={prefs}
              channels={{
                emailOptIn: teacher.emailOptIn,
                pushOptIn: teacher.pushOptIn,
                hasPushDevice: pushCount > 0,
              }}
              // Browser push for this device, feeding the `push` channel.
              // It sits INSIDE the form, directly under the push
              // opt-in whose hint points at it; it used to be a separate block
              // below a card boundary, which is why that hint said "below" and
              // meant "somewhere else".
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
          </SettingRow>
        </SettingsSection>

        <SettingsSection
          id="schedule"
          title={t("web.settings.notifications.youReceiveTitle")}
          description={t("web.settings.notifications.youReceiveDescription")}
        >
          <SettingRow>
            {/* Her OWN prefs, so each group states whether it currently reaches
                her. Without them this is a brochure; with them it answers the
                question the settings above just asked. */}
            <NotificationSchedule audience="teacher" prefs={prefs} />
          </SettingRow>
        </SettingsSection>

        <SettingsSection
          id="students"
          title={t("web.settings.notifications.studentsReceiveTitle")}
          description={t("web.settings.notifications.studentsReceiveDescription")}
        >
          <SettingRow>
            <Collapsible
              title={t("web.settings.notifications.studentsReceiveToggle")}
              defaultOpen={false}
            >
              {/* No `prefs`: every student has their own, so there is no single
                  state to report and the groups render without one. */}
              <NotificationSchedule audience="student" />
            </Collapsible>
          </SettingRow>
        </SettingsSection>
      </div>
    </div>
  );
}
