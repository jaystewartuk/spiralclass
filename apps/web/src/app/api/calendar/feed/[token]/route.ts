import type { NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { resolveFeedOwner } from "@/lib/calendar/feed-token";
import { buildCalendarFeed } from "@/lib/calendar/feed";

// Read-only iCal subscription feed. The token in the path is the only
// credential — it's a per-user random secret, so possession of the URL grants
// read access to that user's class schedule (and nothing else). Clients
// (Google/Apple/Outlook) re-poll this URL on their own schedule.
//
// The path segment carries an optional `.ics` suffix so the URL looks like a
// calendar file to clients that sniff the extension.

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = raw.replace(/\.ics$/i, "");

  const owner = await resolveFeedOwner(token);
  if (!owner) {
    return new Response("Calendar not found", { status: 404 });
  }

  const { ics } = await buildCalendarFeed(owner, { appUrl: serverEnv().APP_URL });

  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // Subscribed clients poll on their own cadence; a short cache smooths
      // bursts without making the feed go stale for long.
      "Cache-Control": "private, max-age=1800",
      "Content-Disposition": 'inline; filename="spiralclass.ics"',
    },
  });
}
