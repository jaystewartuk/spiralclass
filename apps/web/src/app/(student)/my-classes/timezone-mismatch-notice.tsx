"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { zoneCityName, zonesShowDifferentClocks } from "@spiralclass/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { useDeviceTimezone } from "@/hooks/use-device-timezone";
import { switchMyTimezoneAction } from "@/app/actions/student-contact";

// A student who moves keeps the zone she was first seen in: CaptureTimezone
// only fills an EMPTY zone, by design (D-53), so it can never undo a choice
// she made by hand. That left the student who moved from Vienna to Toronto
// reading every class time — portal and emails — on Vienna's clock, with
// nothing to tell her why.
//
// This is the other half of that rule: when the device says she is on a
// different clock from the saved one, OFFER the switch, one tap, and never
// make it for her. "Keep" is remembered on this browser for this exact pair,
// so a student who travels and wants home time is asked once, and asked
// again only if she turns up somewhere else.
//
// Never in a class: the call page sits under this layout too, and a banner
// about her clock pushing the pre-join check down the screen is the wrong
// thing at the wrong moment. She sees it on the next portal page she opens.

export const KEPT_ZONE_STORAGE_KEY = "spiralclass.timezoneNotice.kept";

export function keptPair(saved: string, device: string): string {
  return `${saved}|${device}`;
}

function wasKept(pair: string): boolean {
  try {
    return window.localStorage.getItem(KEPT_ZONE_STORAGE_KEY) === pair;
  } catch {
    return false;
  }
}

export function TimezoneMismatchNotice({ savedTimezone }: { savedTimezone: string }) {
  const t = useT();
  const router = useRouter();
  const inClass = usePathname()?.endsWith("/call") ?? false;
  // Null on the server and during hydration, so the first client render
  // matches the server's (nothing); the device's zone arrives right after.
  const deviceZone = useDeviceTimezone();
  // The pair answered in this visit — kept, or switched while the refreshed
  // saved zone is still on its way.
  const [answered, setAnswered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (inClass) return null;
  if (!deviceZone || !zonesShowDifferentClocks(savedTimezone, deviceZone)) return null;
  const pair = keptPair(savedTimezone, deviceZone);
  if (answered === pair || wasKept(pair)) return null;

  const saved = zoneCityName(savedTimezone);
  const device = zoneCityName(deviceZone);

  function keep() {
    try {
      window.localStorage.setItem(KEPT_ZONE_STORAGE_KEY, pair);
    } catch {
      // Not remembered; hidden for this visit.
    }
    setAnswered(pair);
  }

  function switchToDevice() {
    const zone = deviceZone!;
    setError(null);
    startTransition(async () => {
      const result = await switchMyTimezoneAction(zone);
      if (result?.error) {
        setError(result.error);
        return;
      }
      setAnswered(pair);
      toast.success(t("web.myClasses.timezoneNotice.switched", { device }));
      router.refresh();
    });
  }

  return (
    <div className="container max-w-3xl pt-4">
      <Alert variant="info">
        <AlertDescription className="space-y-3">
          <p className="text-foreground">
            {t("web.myClasses.timezoneNotice.body", { saved, device })}
          </p>
          <p className="text-xs text-muted-foreground">{t("web.myClasses.timezoneNotice.hint")}</p>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={switchToDevice} disabled={pending}>
              {t("web.myClasses.timezoneNotice.switch", { device })}
            </Button>
            <Button size="sm" variant="outline" onClick={keep} disabled={pending}>
              {t("web.myClasses.timezoneNotice.keep", { saved })}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
