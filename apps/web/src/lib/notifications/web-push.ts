// Web Push — the BROWSER transport of the `push` notification channel.
//
// This is deliberately not a new NotificationChannel. `push` means "a push
// notification to a device this recipient has"; that the browser's own push
// service delivers it to an installed PWA is a transport detail. Making it a
// channel would have meant a
// new enum member absent from every existing notification_prefs
// `allowedChannels` allow-list (they store ["push","email"]), silently
// excluding it for every current user — see resolve-channel.ts.
//
// Shape mirrors push.ts on purpose: a `WebPushClient` with a real
// implementation and a recording stub, so dispatcher tests inject either
// transport the same way.
//
// Payload note: the browser push service never sees the message — the payload
// is encrypted client-bound to the subscription's p256dh/auth keys
// by the `web-push` library. The service only learns that *a* message was sent.

import webpush, { WebPushError } from "web-push";

// Matches the shape the browser's PushSubscription serializes to, which is what
// the subscribe route stores and the dispatcher reads back.
export type WebPushSubscriptionRecord = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type WebPushPayload = {
  title: string;
  body: string;
  // Relative path the service worker routes to on notificationclick. Null for
  // templates with no actionable destination — same contract as RenderedPush.
  deepLink: string | null;
  // Groups/replaces notifications on the client. We key it per notification so
  // a redelivery replaces rather than stacks.
  tag?: string;
  // Mirrors the urgency class in push.ts: booking-class notifications are the
  // ones worth interrupting for.
  urgent?: boolean;
};

export type WebPushSendInput = {
  subscriptions: WebPushSubscriptionRecord[];
  payload: WebPushPayload;
};

export type WebPushSendResult = {
  // Ids of subscriptions the push service accepted (201/202).
  deliveredIds: string[];
  // Ids the push service reported as permanently gone (404/410) — the caller
  // soft-revokes these. Distinct from `failedIds`: a gone subscription must
  // never be retried, a failed one may succeed next time.
  goneIds: string[];
  // Ids that failed for a transient/unknown reason (network, 5xx, 429).
  failedIds: string[];
  // Distinct error codes seen, for the diagnosable-outage requirement the
  // dispatcher's push branch already enforces.
  errorCodes: string[];
};

export type WebPushClient = {
  send(input: WebPushSendInput): Promise<WebPushSendResult>;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

// Returns null when web push isn't configured. Every caller treats null as
// "this transport doesn't exist right now" and carries on — a missing VAPID
// keypair must never fail a dispatch that email can still serve.
export function vapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export function isWebPushConfigured(): boolean {
  return vapidConfig() !== null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let cachedClient: WebPushClient | null = null;

export function getWebPushClient(): WebPushClient {
  if (cachedClient) return cachedClient;
  cachedClient = createRealWebPushClient();
  return cachedClient;
}

// Test seam: lets a test reset the module-level cache between cases.
export function resetWebPushClientCache(): void {
  cachedClient = null;
}

export function createRealWebPushClient(config?: VapidConfig): WebPushClient {
  return {
    async send(input) {
      const result: WebPushSendResult = {
        deliveredIds: [],
        goneIds: [],
        failedIds: [],
        errorCodes: [],
      };
      if (input.subscriptions.length === 0) return result;

      const vapid = config ?? vapidConfig();
      if (!vapid) {
        // Not configured: report every subscription as a non-gone failure so
        // the caller falls through to another channel rather than revoking
        // perfectly good subscriptions.
        result.failedIds = input.subscriptions.map((s) => s.id);
        result.errorCodes = ["NotConfigured"];
        return result;
      }

      const body = JSON.stringify({
        title: input.payload.title,
        body: input.payload.body,
        deepLink: input.payload.deepLink,
        tag: input.payload.tag,
        urgent: input.payload.urgent === true,
      });

      const codes = new Set<string>();
      await Promise.all(
        input.subscriptions.map(async (sub) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth },
              },
              body,
              {
                vapidDetails: {
                  subject: vapid.subject,
                  publicKey: vapid.publicKey,
                  privateKey: vapid.privateKey,
                },
                // Push services hold an undelivered message for at most this
                // long. A class reminder is worthless a day later, so cap it
                // well below the 4-week default.
                TTL: input.payload.urgent ? 30 * 60 : 6 * 60 * 60,
                urgency: input.payload.urgent ? "high" : "normal",
              },
            );
            result.deliveredIds.push(sub.id);
          } catch (err) {
            // 404/410 is the push service telling us this subscription is
            // permanently dead (permission revoked, browser data cleared).
            // Anything else may succeed on a later send.
            const status = err instanceof WebPushError ? err.statusCode : 0;
            if (status === 404 || status === 410) {
              result.goneIds.push(sub.id);
              codes.add(`Gone:${status}`);
              return;
            }
            result.failedIds.push(sub.id);
            codes.add(status ? `Http:${status}` : "Unknown");
          }
        }),
      );
      result.errorCodes = [...codes];
      return result;
    },
  };
}

// Test-only / fixture client. Records calls; treats everything as delivered
// unless a per-endpoint outcome is preloaded.
export function createStubWebPushClient(
  outcomes?: Record<string, "delivered" | "gone" | "failed">,
): WebPushClient & { sentBatches: WebPushSendInput[] } {
  const sentBatches: WebPushSendInput[] = [];
  return {
    sentBatches,
    async send(input) {
      sentBatches.push(input);
      const result: WebPushSendResult = {
        deliveredIds: [],
        goneIds: [],
        failedIds: [],
        errorCodes: [],
      };
      for (const sub of input.subscriptions) {
        const outcome = outcomes?.[sub.endpoint] ?? "delivered";
        if (outcome === "delivered") result.deliveredIds.push(sub.id);
        else if (outcome === "gone") result.goneIds.push(sub.id);
        else result.failedIds.push(sub.id);
      }
      if (result.goneIds.length > 0) result.errorCodes.push("Gone:410");
      if (result.failedIds.length > 0) result.errorCodes.push("Http:500");
      return result;
    },
  };
}
