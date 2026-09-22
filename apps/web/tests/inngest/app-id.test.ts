import { describe, expect, it } from "vitest";

import { INNGEST_APP_ID } from "@/lib/inngest/app-id";

// Tripwire — DO NOT casually "fix" this test to make it green.
//
// The Inngest app id is the app's identity in Inngest Cloud. Renaming it makes
// Inngest treat the next deploy as a brand-new app: the functions registered
// under the old id are orphaned, so every event (notification dispatch,
// reminders, payout transfers, …) is still accepted but has no subscriber and
// silently stops running. This is exactly what caused the 2026-07-07 total
// email+push notification outage after the app id was renamed
// clases-estructuradas → agendaprofe (D-43) without a re-sync.
//
// The 2026-08-29 product rename to SpiralClass (D-138) deliberately did NOT
// touch this id, for the reason above: it is a live registration key, not a
// brand string. It is one of the identifiers D-138 lists as keeping the old
// name.
//
// If you INTENTIONALLY rename the app id, update the constant AND re-sync the
// app in the Inngest dashboard for BOTH the production and preview
// environments as part of the same change.
describe("inngest app id", () => {
  it("stays 'agendaprofe' so registered functions are never silently orphaned", () => {
    expect(INNGEST_APP_ID).toBe("agendaprofe");
  });
});
