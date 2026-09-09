import type { MaterialTiming } from "@/lib/notifications/materials";

// — a class material's send moment relative to the class start.
// Single source of truth for two questions that must agree:
//   * upload time: "is the chosen send time already past?" → enqueue the
//     materials_send immediately instead of waiting for a reminder leg
//     that already fired (or never will).
//   * student views: "should this material be visible yet?" — students
//     only see materials whose send time has elapsed.
// "confirmation" materials send at booking time, which is always in the
// past once the class exists. `timing` is null for a booking-scoped
// LibraryMaterial that isn't on a push schedule at all (D-69: the merged
// "content" material) — those are always visible, no elapsing to check.
export function materialSendTimeElapsed(
  timing: MaterialTiming | null,
  scheduledStart: Date,
  now: Date,
): boolean {
  if (timing === null || timing === "confirmation") return true;
  const offsetMs =
    timing === "t_5d" ? 5 * 24 * 3600_000 : timing === "t_24h" ? 24 * 3600_000 : 3600_000;
  return now.getTime() >= scheduledStart.getTime() - offsetMs;
}
