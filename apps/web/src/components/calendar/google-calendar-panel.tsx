"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import type { GoogleCalendarActionState } from "@/app/actions/google-calendar";

type Action = (
  prev: GoogleCalendarActionState,
  formData: FormData,
) => Promise<GoogleCalendarActionState>;

export function GoogleCalendarPanel({
  connected,
  googleEmail,
  lastSyncedLabel,
  syncEnabled,
  lastSyncError,
  disconnectAction,
  resyncAction,
  setEnabledAction,
}: {
  connected: boolean;
  googleEmail: string | null;
  lastSyncedLabel: string | null;
  syncEnabled: boolean;
  lastSyncError: string | null;
  disconnectAction: Action;
  resyncAction: Action;
  setEnabledAction: Action;
}) {
  const t = useT();
  const [, disconnect, disconnecting] = useActionState(disconnectAction, undefined);
  const [, resync, resyncing] = useActionState(resyncAction, undefined);
  const [, setEnabled, toggling] = useActionState(setEnabledAction, undefined);

  if (!connected) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("web.calendarSync.google.connectHelp")}</p>
        <Button asChild>
          <a href="/api/calendar/google/start">{t("calendarSync.google.connect")}</a>
        </Button>
        <p className="text-xs text-muted-foreground">{t("web.calendarSync.google.readOnlyNote")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium">
            {t("calendarSync.google.connected")}
            {googleEmail ? ` · ${googleEmail}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {syncEnabled
              ? lastSyncedLabel
                ? t("calendarSync.google.lastSynced", { when: lastSyncedLabel })
                : t("web.calendarSync.google.waitingFirstSync")
              : t("web.calendarSync.google.importPaused")}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            syncEnabled ? "bg-success-bg text-success" : "bg-muted text-muted-foreground"
          }`}
        >
          {syncEnabled ? t("web.calendarSync.google.active") : t("web.calendarSync.google.paused")}
        </span>
      </div>

      {lastSyncError && syncEnabled && (
        <p className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
          {t("web.calendarSync.google.syncError")}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {syncEnabled && (
          <form action={resync}>
            <Button type="submit" variant="outline" size="sm" disabled={resyncing}>
              {resyncing ? t("web.calendarSync.google.syncing") : t("calendarSync.google.resync")}
            </Button>
          </form>
        )}
        <form action={setEnabled}>
          <input type="hidden" name="enabled" value={syncEnabled ? "false" : "true"} />
          <Button type="submit" variant="outline" size="sm" disabled={toggling}>
            {syncEnabled ? t("web.calendarSync.google.pause") : t("web.calendarSync.google.resume")}
          </Button>
        </form>
        <form action={disconnect}>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            disabled={disconnecting}
            className="text-muted-foreground"
          >
            {disconnecting
              ? t("web.calendarSync.google.disconnecting")
              : t("calendarSync.google.disconnect")}
          </Button>
        </form>
      </div>
    </div>
  );
}
