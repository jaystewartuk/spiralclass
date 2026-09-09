// The Inngest app id — the app's identity in Inngest Cloud.
//
// Isolated in its own env-free module so it can be asserted by a unit test
// (tests/inngest/app-id.test.ts) without booting the full client, which
// validates the server env at load.
//
// Renaming this makes Inngest treat the next deploy as a brand-new app and
// orphans every already-registered function until the app is manually
// re-synced (prod + preview) — the cause of the 2026-07-07 total email+push
// outage. Do not rename without re-syncing in the same change.
export const INNGEST_APP_ID = "agendaprofe";
