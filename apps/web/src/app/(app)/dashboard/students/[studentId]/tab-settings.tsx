import type { Teacher } from "@prisma/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HelpTip } from "@/components/help-tip";
import { isNotificationsFullyDisabled } from "@/lib/notifications/preferences";
import type { TFunction } from "@/lib/i18n-translate";
import { ContactEditForm } from "./contact-edit-form";
import { NotificationsToggle } from "./notifications-toggle";
import { StudentArchiveButton } from "./student-archive-button";

/**
 * The things that change once, and the one that ends the relationship.
 *
 * Contact details, notifications and archiving were three separate cards in
 * the middle of the old single column, each with the same visual weight as the
 * learning profile — so a form for fixing a typo in an email address competed
 * for attention with the reason the teacher opened the page. They are the
 * least-used controls here, so they are behind the last tab, and the
 * destructive one is last inside it and visually distinct.
 */
export function SettingsTab({
  studentId,
  teacher,
  t,
  link,
}: {
  studentId: string;
  teacher: Teacher;
  t: TFunction;
  link: {
    archivedAt: Date | null;
    student: {
      name: string;
      email: string | null;
      phoneE164: string | null;
      authUserId: string | null;
      notificationPrefs: unknown;
    };
  };
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg" as="h2">
            {t("web.dashboard.students.contact.cardTitle")}
            <HelpTip
              label={t("web.dashboard.students.contact.helpLabel")}
              text={t("web.dashboard.students.contact.helpText")}
            />
          </CardTitle>
          <CardDescription>{t("web.dashboard.students.contact.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ContactEditForm
            studentId={studentId}
            initialName={link.student.name}
            initialEmail={link.student.email}
            initialPhone={link.student.phoneE164}
            emailLocked={link.student.authUserId != null}
            defaultPhoneCountry={teacher.country}
          />
          <NotificationsToggle
            studentId={studentId}
            enabled={!isNotificationsFullyDisabled(link.student.notificationPrefs as object | null)}
          />
        </CardContent>
      </Card>

      {/* Bordered in the destructive role rather than merely placed last: the
          control inside it removes a student from the roster, and an
          undifferentiated card three scrolls down is how that gets clicked by
          someone who meant to pause a package. */}
      <Card className="border-destructive/30">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg" as="h2">
            {t("web.dashboard.students.rosterStatus.title")}
            <HelpTip
              label={t("web.dashboard.students.archive.helpLabel")}
              text={t("web.dashboard.students.archive.helpText")}
            />
          </CardTitle>
          <CardDescription>
            {link.archivedAt
              ? t("web.dashboard.students.rosterStatus.archivedDescription")
              : t("web.dashboard.students.rosterStatus.activeDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StudentArchiveButton studentId={studentId} archived={link.archivedAt != null} />
        </CardContent>
      </Card>
    </div>
  );
}
