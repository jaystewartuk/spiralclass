import { buildVcalendar, formatIcsUtc, type IcsEvent } from "@/lib/calendar/ics";

// "Add to calendar" link/file builders for a single booking.
//
// Two complementary outputs:
//   * a Google Calendar template URL — a plain link that prefills the event in
//     Google Calendar. Works in email (no auth, no download), which is why the
//     transactional emails use it.
//   * `.ics` content — for Apple Calendar / Outlook users, offered as a direct
//     download in-app (rendered server-side, downloaded client-side via a Blob
//     so there's no unauthenticated per-booking route to leak class details).

export type CalendarBooking = {
  start: Date;
  end: Date;
  title: string;
  details?: string;
  location?: string;
};

/** Build a Google Calendar "render template" URL that prefills the event. */
export function buildGoogleCalendarUrl(booking: CalendarBooking): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: booking.title,
    dates: `${formatIcsUtc(booking.start)}/${formatIcsUtc(booking.end)}`,
  });
  if (booking.details) params.set("details", booking.details);
  if (booking.location) params.set("location", booking.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Both "add to calendar" outputs for one booking: a Google template URL and a
 * single-event `.ics` document. `uid` keeps the downloaded event stable so a
 * re-download updates rather than duplicates.
 */
export function buildBookingCalendarLinks(input: { uid: string; booking: CalendarBooking }): {
  googleUrl: string;
  ics: string;
} {
  const event: IcsEvent = {
    uid: input.uid,
    start: input.booking.start,
    end: input.booking.end,
    summary: input.booking.title,
    description: input.booking.details,
    location: input.booking.location,
    status: "CONFIRMED",
  };
  return {
    googleUrl: buildGoogleCalendarUrl(input.booking),
    ics: buildVcalendar([event]),
  };
}
