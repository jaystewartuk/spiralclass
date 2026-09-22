import { randomBytes } from "crypto";

import { prisma } from "@/lib/prisma";
import {
  BOOKING_SLUG_MAX,
  BOOKING_SLUG_MIN,
  normalizeBookingSlug,
  validateBookingSlug,
} from "@/lib/slug";

// Advisory availability for the booking-slug editor — drives the live
// "available / taken" hint as the teacher types so they can fix a clash
// before pressing Save. The authoritative gate stays the unique constraint on
// the save write (this read can race a concurrent claim); a "taken" here is a
// hint, and an "available" here is not a reservation. On a clash we also hand
// back a few free alternatives, the way social handles do.
export type BookingSlugAvailability =
  | { status: "current"; slug: string }
  | { status: "available"; slug: string }
  | { status: "taken"; slug: string; suggestions: string[] }
  | { status: "invalid"; reason: "too-short" | "reserved" };

// How many free alternatives to offer on a clash.
const SUGGESTION_COUNT = 3;

// Build a spread of candidate slugs derived from the one the teacher wanted:
// a few human-friendly variants first, then random-suffixed fallbacks that are
// practically always free, so we can almost always offer something. All are
// re-normalized and length-checked; duplicates are dropped.
function suggestionCandidates(base: string): string[] {
  // Leave headroom for the appended suffixes and drop any trailing hyphen the
  // slice may expose.
  const root = base.slice(0, BOOKING_SLUG_MAX - 6).replace(/-+$/g, "") || base;
  const out: string[] = [];
  const add = (value: string) => {
    const candidate = normalizeBookingSlug(value);
    if (candidate.length >= BOOKING_SLUG_MIN && candidate !== base && !out.includes(candidate)) {
      out.push(candidate);
    }
  };

  add(`${root}-mx`);
  add(`${root}-clases`);
  add(`${root}1`);
  add(`${root}2`);
  add(`${root}-online`);
  // Random-suffix fallbacks guarantee we have enough free options even when
  // every friendly variant above is already taken.
  for (let i = 0; i < SUGGESTION_COUNT; i++) {
    add(`${root}-${randomBytes(2).toString("hex")}`);
  }
  return out;
}

// Of a candidate pool, return up to SUGGESTION_COUNT that no teacher holds —
// one batched query rather than a probe per candidate.
async function freeSuggestions(base: string): Promise<string[]> {
  const candidates = suggestionCandidates(base);
  if (candidates.length === 0) return [];
  const taken = await prisma.teacher.findMany({
    where: { bookingSlug: { in: candidates } },
    select: { bookingSlug: true },
  });
  const takenSet = new Set(taken.map((t) => t.bookingSlug));
  return candidates.filter((c) => !takenSet.has(c)).slice(0, SUGGESTION_COUNT);
}

export async function checkBookingSlugAvailability(
  teacherId: string,
  currentSlug: string,
  input: string,
): Promise<BookingSlugAvailability> {
  const result = validateBookingSlug(input);
  if (!result.ok) return { status: "invalid", reason: result.reason };
  // The teacher's own slug always reads as available to them — no point
  // flagging "taken" against themselves, and it lets the editor show a calm
  // "this is your link" state.
  if (result.slug === currentSlug) return { status: "current", slug: result.slug };

  const existing = await prisma.teacher.findUnique({
    where: { bookingSlug: result.slug },
    select: { id: true },
  });
  if (existing && existing.id !== teacherId) {
    return {
      status: "taken",
      slug: result.slug,
      suggestions: await freeSuggestions(result.slug),
    };
  }
  return { status: "available", slug: result.slug };
}
