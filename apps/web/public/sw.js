/* SpiralClass service worker — Web Push only.
 *
 * Deliberately NOT a caching/offline worker. Its entire job is to receive push
 * messages and route a tap, because that is the one capability a browser tab
 * cannot provide. Adding a fetch handler here would put this file on the
 * critical path of every request in the app, which is a much larger change
 * with its own (cache-invalidation) failure modes — not something to acquire
 * as a side effect of turning notifications on.
 *
 * Served from /sw.js so its scope is the whole origin. Excluded from the
 * middleware matcher (src/middleware.ts) — it is a static asset that needs no
 * session work, and it must stay fetchable during registration.
 *
 * Payload contract is produced by lib/notifications/web-push.ts:
 *   { title, body, deepLink, tag, urgent }
 * `deepLink` is already a WEB pathname (the server ran webPathForDeepLink over
 * the dispatcher suffix), so it can be resolved against the origin directly.
 */

// Take over already-open tabs as soon as a new worker version activates,
// instead of waiting for every tab to close. Without this, a subscriber who
// never fully closes the app keeps running the old worker indefinitely.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    // A push with a non-JSON body isn't ours. Showing a notification anyway
    // would render "[object Object]" or raw text to the user; dropping it is
    // the honest outcome. (Browsers may show a generic "site updated in the
    // background" notice, which is the platform's choice, not ours.)
    return;
  }

  const title = typeof payload.title === "string" ? payload.title : "SpiralClass";
  const body = typeof payload.body === "string" ? payload.body : "";
  const deepLink = typeof payload.deepLink === "string" ? payload.deepLink : null;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // NOT `/icon.svg`, and not one asset for both.
      //
      // `/icon.svg` is Next's file-convention route: a path whose bytes change
      // with the design while the URL never does, served
      // `max-age=31536000, immutable`. The HTML <link> gets a content hash
      // appended and is fine; a service worker cannot append one, so every
      // push fetched the bare path and Cloudflare handed back whatever it
      // cached first — the PREVIOUS brand's terracotta monogram, months after
      // the rename, next to a correct app icon. This is the identical bug the
      // manifest hit (src/app/manifest.ts), in a second file, found the same
      // way: by looking at a real notification. The assets under /brand are
      // written by scripts/brand-assets.mjs, so their bytes change in the same
      // commit as the design.
      //
      // Two different assets because Android uses them differently. `icon` is
      // the large image beside the text and wants the full-bleed tile, which
      // is what the maskable PNG is. `badge` is the status-bar glyph and only
      // its ALPHA is read — a filled tile there is a solid white square, which
      // is what shipped; the mark is stroke-on-transparent, so it masks to the
      // spiral itself.
      icon: "/brand/icon-maskable-192.png",
      badge: "/brand/mark-ink.png",
      // One notification row = one notification: a redelivery of the same
      // notification replaces it rather than stacking a duplicate.
      tag: typeof payload.tag === "string" ? payload.tag : undefined,
      renotify: payload.urgent === true,
      // Class-imminent notices keep the notification up until acknowledged;
      // everything else may auto-dismiss, mirroring the booking-vs-default
      // channel split the Android client uses (lib/notifications/push.ts).
      requireInteraction: payload.urgent === true,
      data: { deepLink },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const deepLink = event.notification.data && event.notification.data.deepLink;
  const target = new URL(deepLink || "/", self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Prefer focusing a tab that is already on this origin and navigating it,
      // rather than opening a duplicate tab of an app the user already has
      // open. Only same-origin clients are navigable.
      for (const client of clientList) {
        if (new URL(client.url).origin !== target.origin) continue;
        if ("focus" in client) {
          const focused = client.focus();
          if ("navigate" in client && client.url !== target.href) {
            return Promise.resolve(focused).then(() => client.navigate(target.href));
          }
          return focused;
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});

// The push service can rotate a subscription without user action. The old
// endpoint stops working at that moment, so the page re-subscribes and re-posts
// on its next load (see WebPushToggle). We can't call our own authenticated API
// from here — the worker has no session — so this only cleans up the client
// side and lets the server revoke the dead endpoint on its next 410.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.registration.pushManager
      .getSubscription()
      .then((sub) => (sub ? sub.unsubscribe() : undefined))
      .catch(() => undefined),
  );
});
