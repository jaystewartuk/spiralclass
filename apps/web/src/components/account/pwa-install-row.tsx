"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import {
  hasInstallPrompt,
  isRunningStandalone,
  onInstallPromptChange,
  promptInstall,
  wasInstalled,
} from "@/lib/pwa/install-prompt";

// Offers the one-tap install, in the place a reader is already trying to make
// notifications work.
//
// DELIBERATELY NOT A BANNER, and deliberately not shown everywhere. Installing
// this IS the app — but the reader who wants it is the one setting up
// notifications, not the one buying a class on /b/**.
// Chrome also shows its own mini-infobar, so a second nag on every page would
// be the same ask twice.
//
// It renders ONLY when there is a real one-tap install to offer, i.e. a
// captured `beforeinstallprompt`. That is narrow on purpose:
//
//   - iOS is already handled, and better, by WebPushToggle's
//     `ios-needs-install` state — Safari never fires this event, and on iOS
//     Web Push does not exist AT ALL until the site is on the Home Screen, so
//     the instructions belong with the control they unblock rather than here.
//   - Firefox and desktop Safari cannot install at all. Printing steps nobody
//     can follow is worse than printing nothing.

/** One stable primitive for useSyncExternalStore. */
type InstallState = "hidden" | "available" | "installed";

function snapshot(): InstallState {
  if (wasInstalled()) return "installed";
  if (isRunningStandalone()) return "hidden";
  return hasInstallPrompt() ? "available" : "hidden";
}

// The server renders "hidden": nothing here can be known before hydration, and
// rendering the row optimistically would flash a control that then vanishes on
// every browser that cannot install.
const serverSnapshot = (): InstallState => "hidden";

export function PwaInstallRow() {
  const t = useT();
  const state = useSyncExternalStore(onInstallPromptChange, snapshot, serverSnapshot);
  const [working, setWorking] = useState(false);

  const install = useCallback(async () => {
    setWorking(true);
    // A dismissal is a decision, not a failure — the row simply goes away with
    // the single-use event, and nothing is said about it. `appinstalled` is
    // what flips this to "installed", so an accept is reported by the browser
    // rather than assumed here.
    await promptInstall();
    setWorking(false);
  }, []);

  if (state === "hidden") return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{t("web.pwaInstall.title")}</p>
            {state === "installed" ? (
              <Badge variant="success">{t("web.pwaInstall.badge.installed")}</Badge>
            ) : null}
          </div>
          {/* The row carries a WORD for the installed state rather than simply
              disappearing: a control that vanishes reads as a rendering bug
              instead of as the thing having worked (D-140). */}
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {state === "installed" ? t("web.pwaInstall.installedHelp") : t("web.pwaInstall.help")}
          </p>
        </div>
        {state === "available" ? (
          <Button type="button" variant="outline" disabled={working} onClick={install}>
            {t("web.pwaInstall.action")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
