import { GOOGLE_FREEBUSY_ENDPOINT } from "./config";

// Google Calendar free/busy query. Returns only opaque busy intervals (never
// event titles or details), which is exactly what busy-import needs — minimal
// data, minimal privacy surface.

export type BusyInterval = { startsAt: Date; endsAt: Date };

/**
 * Query the teacher's primary calendar for busy intervals in [timeMin, timeMax].
 * `accessToken` must be a valid (refreshed) Google access token.
 */
export async function queryFreeBusy(
  accessToken: string,
  range: { timeMin: Date; timeMax: Date },
): Promise<BusyInterval[]> {
  const res = await fetch(GOOGLE_FREEBUSY_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: range.timeMin.toISOString(),
      timeMax: range.timeMax.toISOString(),
      items: [{ id: "primary" }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`google freeBusy failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
  };
  return parseFreeBusy(json);
}

/** Pure parser for a freeBusy response → busy intervals (exported for tests). */
export function parseFreeBusy(json: {
  calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
}): BusyInterval[] {
  const primary = json.calendars?.primary;
  if (!primary?.busy) return [];
  return primary.busy
    .map((b) => ({ startsAt: new Date(b.start), endsAt: new Date(b.end) }))
    .filter(
      (b) =>
        !Number.isNaN(b.startsAt.getTime()) &&
        !Number.isNaN(b.endsAt.getTime()) &&
        b.endsAt > b.startsAt,
    );
}
