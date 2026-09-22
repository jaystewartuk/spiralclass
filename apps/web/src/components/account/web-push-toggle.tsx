"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/components/locale-provider";

// Turns browser push notifications on for THIS browser, feeding the `push`
// notification channel, so a teacher on an iPhone gets class reminders on her
// phone without an installed app.
//
// Deliberately per-device, not an account setting: a subscription belongs to
// one browser on one machine. The account-level "do you want push at all"
// switch is the existing pushOptIn checkbox in NotificationPrefsForm; this
// grants the browser permission that makes it deliverable.

type State =
  | "loading"
  | "unsupported" // no service worker / PushManager (or a non-secure context)
  | "ios-needs-install" // iOS Safari: Web Push only exists once installed to the Home Screen
  | "unconfigured" // server has no VAPID keypair
  | "denied" // user blocked notifications at the browser level
  | "off"
  | "on"
  | "working";

// The VAPID public key is delivered as base64url and the subscribe API wants a
// BufferSource. Backed by an explicit ArrayBuffer so the result is
// `Uint8Array<ArrayBuffer>` — the bare `new Uint8Array(len)` form widens to
// ArrayBufferLike, which `applicationServerKey` (BufferSource) rejects.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// iOS exposes Web Push ONLY to a site installed to the Home Screen — in a
// normal Safari tab `PushManager` is absent entirely. Detecting the platform
// lets us say "add this to your Home Screen first" instead of the flatly wrong
// "your browser doesn't support notifications".
function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as a Mac; the touch-point count distinguishes it.
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return iOS || iPadOS;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // Safari's non-standard flag, still the only signal on iOS.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function WebPushToggle() {
  const t = useT();
  const [state, setState] = useState<State>("loading");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const supported =
        typeof window !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window;

      if (!supported) {
        if (!cancelled)
          setState(isIosSafari() && !isStandalone() ? "ios-needs-install" : "unsupported");
        return;
      }

      let config: { enabled: boolean; publicKey: string | null };
      try {
        const res = await fetch("/api/web-push/subscription");
        if (!res.ok) throw new Error(String(res.status));
        config = await res.json();
      } catch {
        if (!cancelled) setState("unconfigured");
        return;
      }
      if (cancelled) return;
      if (!config.enabled || !config.publicKey) {
        setState("unconfigured");
        return;
      }
      setPublicKey(config.publicKey);

      if (Notification.permission === "denied") {
        setState("denied");
        return;
      }

      // Reflect what this browser already has rather than what the server
      // stored: the browser is the source of truth for whether a subscription
      // exists here, and it can drop one without telling us.
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const existing = registration ? await registration.pushManager.getSubscription() : null;
      if (!cancelled) setState(existing ? "on" : "off");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    if (!publicKey) return;
    setError(null);
    setState("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      // A just-registered worker may still be installing; subscribing before
      // it is active throws in some browsers.
      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        // Required to be true by every browser that implements Web Push: a
        // push must result in a visible notification.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const res = await fetch("/api/web-push/subscription", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!res.ok) {
        // Don't leave the browser holding a subscription the server doesn't
        // know about — it would look enabled here and deliver nothing.
        await subscription.unsubscribe().catch(() => undefined);
        throw new Error(String(res.status));
      }
      setState("on");
    } catch {
      setError(t("web.webPush.error"));
      setState("off");
    }
  }, [publicKey, t]);

  const disable = useCallback(async () => {
    setError(null);
    setState("working");
    try {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (subscription) {
        await fetch("/api/web-push/subscription", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => undefined);
        await subscription.unsubscribe();
      }
      setState("off");
    } catch {
      setError(t("web.webPush.error"));
      setState("on");
    }
  }, [t]);

  // A skeleton, not nothing. Asking the browser takes a round trip through
  // `/api/web-push/subscription` and the service-worker registration, and
  // returning null meanwhile made the whole row appear late and shove the rest
  // of the section down after the reader had already started reading it.
  if (state === "loading") {
    return (
      <div className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
    );
  }

  // Not configured server-side: show nothing rather than a control that can't
  // work. This is what a deploy without a VAPID keypair looks like.
  if (state === "unconfigured") return null;

  // Every blocked state carries a WORD as well as an explanation — a row that
  // simply lacks a button reads as a rendering bug, not as a decision the
  // browser made (D-140: status is never carried by absence or by hue).
  const blockedBadgeKey =
    state === "denied"
      ? "web.webPush.badge.blocked"
      : state === "unsupported" || state === "ios-needs-install"
        ? "web.webPush.badge.unavailable"
        : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{t("web.webPush.title")}</p>
            {blockedBadgeKey ? <Badge variant="secondary">{t(blockedBadgeKey)}</Badge> : null}
            {state === "on" ? <Badge variant="success">{t("web.webPush.badge.on")}</Badge> : null}
          </div>
          {/* Turning this on or off changes nothing else visible on the page,
              so the sentence under it is the only confirmation there is. */}
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {state === "ios-needs-install"
              ? t("web.webPush.iosNeedsInstall")
              : state === "unsupported"
                ? t("web.webPush.unsupported")
                : state === "denied"
                  ? t("web.webPush.denied")
                  : state === "on"
                    ? t("web.webPush.onHelp")
                    : t("web.webPush.offHelp")}
          </p>
        </div>
        {(state === "on" || state === "off" || state === "working") && (
          <Button
            type="button"
            variant={state === "on" ? "outline" : "default"}
            disabled={state === "working"}
            onClick={state === "on" ? disable : enable}
          >
            {state === "on" ? t("web.webPush.disable") : t("web.webPush.enable")}
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
