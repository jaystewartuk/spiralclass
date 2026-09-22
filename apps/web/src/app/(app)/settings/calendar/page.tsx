import { requireTeacher } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { serverEnv, hasGoogleCalendarCreds } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getOrCreateTeacherFeedToken } from "@/lib/calendar/feed-token";
import { CalendarSyncPanel } from "@/components/calendar/calendar-sync-panel";
import { GoogleCalendarPanel } from "@/components/calendar/google-calendar-panel";
import { regenerateTeacherFeedAction } from "@/app/actions/calendar-feed";
import {
  disconnectGoogleCalendarAction,
  resyncGoogleCalendarAction,
  setGoogleSyncEnabledAction,
} from "@/app/actions/google-calendar";
import { formatZonedDateTime } from "@/lib/date-display";

// Settings → Calendar. Two halves:
//   * the read-only subscription feed (Phase 2) — push classes OUT to any app;
//   * Google Calendar busy-import (Phase 3) — pull external busy times IN so
//     students can't book over them. The Google half only renders when the
//     OAuth credentials are configured (otherwise the feature is dormant).
export default async function CalendarSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string }>;
}) {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const { google: googleStatus } = await searchParams;

  const token = await getOrCreateTeacherFeedToken(teacher.id);
  const feedUrl = `${serverEnv().APP_URL.replace(/\/$/, "")}/api/calendar/feed/${token}.ics`;

  const googleEnabled = hasGoogleCalendarCreds();
  const connection = googleEnabled
    ? await prisma.googleCalendarConnection.findUnique({ where: { teacherId: teacher.id } })
    : null;

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.settings.calendar.title")} />
        <p className="text-sm text-muted-foreground">{t("web.settings.calendar.subtitle")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("web.settings.calendar.subscriptionLinkTitle")}</CardTitle>
          <CardDescription>
            {t("web.settings.calendar.subscriptionLinkDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CalendarSyncPanel feedUrl={feedUrl} regenerateAction={regenerateTeacherFeedAction} />
        </CardContent>
      </Card>

      {googleEnabled && (
        <Card>
          <CardHeader>
            <CardTitle>{t("web.settings.calendar.googleTitle")}</CardTitle>
            <CardDescription>{t("web.settings.calendar.googleDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {googleStatus === "denied" && (
              <p className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
                {t("web.settings.calendar.connectionCancelled")}
              </p>
            )}
            {googleStatus === "error" && (
              <p className="rounded-md border border-destructive/30 bg-destructive-bg px-3 py-2 text-xs text-destructive">
                {t("web.settings.calendar.connectionError")}
              </p>
            )}
            <GoogleCalendarPanel
              connected={Boolean(connection)}
              googleEmail={connection?.googleEmail ?? null}
              lastSyncedLabel={
                connection?.lastSyncedAt
                  ? formatZonedDateTime(connection.lastSyncedAt, teacher.timezone, locale)
                  : null
              }
              syncEnabled={connection?.syncEnabled ?? true}
              lastSyncError={connection?.lastSyncError ?? null}
              disconnectAction={disconnectGoogleCalendarAction}
              resyncAction={resyncGoogleCalendarAction}
              setEnabledAction={setGoogleSyncEnabledAction}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
