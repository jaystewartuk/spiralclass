// Minimal, dependency-free iCalendar (RFC 5545) serialisation for the calendar
// feed + single-booking downloads. We emit UTC instants (DTSTART/DTEND with a
// trailing `Z`) so calendar clients localise to the viewer's zone — the same
// reason the rest of the app stores `timestamptz`. No VTIMEZONE blocks needed.

export type IcsEventStatus = "CONFIRMED" | "CANCELLED";

export type IcsEvent = {
  /** Stable unique id — keep it constant across feed refreshes for the same
   *  class so clients update rather than duplicate. */
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  status?: IcsEventStatus;
  /** Drives the client's "this event changed" detection on re-sync. */
  lastModified?: Date;
};

export type IcsCalendarOptions = {
  /** Shown as the calendar name in Google/Apple when subscribed. */
  name?: string;
  /** Hint to clients for how often to re-poll a subscribed feed. */
  refresh?: string; // ISO-8601 duration, e.g. "PT12H"
};

const PRODID = "-//SpiralClass//Calendar//EN";

/** Format a Date as an RFC 5545 UTC timestamp: `YYYYMMDDTHHMMSSZ`. */
export function formatIcsUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** Escape a text value per RFC 5545 §3.3.11 (backslash, comma, semicolon, newline). */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Fold a content line to ≤75 octets, continuation lines prefixed with a space
// (RFC 5545 the teacher profile). Folding is byte-aware so accented es-MX names never split
// mid-codepoint.
function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    const limit = chunks.length === 0 ? 75 : 74; // continuation lines carry a leading space
    if (curBytes + chBytes > limit) {
      chunks.push(cur);
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.join("\r\n ");
}

export function buildVevent(event: IcsEvent, dtstamp: Date = new Date()): string {
  const lines: string[] = ["BEGIN:VEVENT"];
  lines.push(`UID:${escapeIcsText(event.uid)}`);
  lines.push(`DTSTAMP:${formatIcsUtc(dtstamp)}`);
  lines.push(`DTSTART:${formatIcsUtc(event.start)}`);
  lines.push(`DTEND:${formatIcsUtc(event.end)}`);
  lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.url) lines.push(`URL:${escapeIcsText(event.url)}`);
  if (event.status) lines.push(`STATUS:${event.status}`);
  if (event.lastModified) lines.push(`LAST-MODIFIED:${formatIcsUtc(event.lastModified)}`);
  lines.push("END:VEVENT");
  return lines.map(foldLine).join("\r\n");
}

export function buildVcalendar(events: IcsEvent[], options: IcsCalendarOptions = {}): string {
  const dtstamp = new Date();
  const header = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (options.name) {
    header.push(`X-WR-CALNAME:${escapeIcsText(options.name)}`);
    header.push(`NAME:${escapeIcsText(options.name)}`);
  }
  if (options.refresh) {
    header.push(`REFRESH-INTERVAL;VALUE=DURATION:${options.refresh}`);
    header.push(`X-PUBLISHED-TTL:${options.refresh}`);
  }
  const body = events.map((e) => buildVevent(e, dtstamp));
  const all = [...header.map(foldLine), ...body, "END:VCALENDAR"];
  // RFC 5545 requires CRLF line breaks; trailing CRLF is conventional.
  return all.join("\r\n") + "\r\n";
}
