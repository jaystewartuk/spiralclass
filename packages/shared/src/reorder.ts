// Pure, platform-neutral helpers for teacher-defined manual ordering of a
// grouped list — the model behind focus-tag categories and the tags nested
// inside each one (a category is a "group", scoped by `categoryId`). Kept
// generic over row shape (only `id`, and a group-id accessor) rather than
// importing the FocusTag types directly, since the web settings page and the
// mobile FocusTagsManager each keep their own local row shape.
//
// The convention these support is the same "replace-set" one used everywhere
// else in this codebase (see saveFocusTagsForTeacher, dashboard-layout.ts):
// the caller holds the whole current array in memory, calls one of these to
// produce the next array, and persists the whole thing — the array's index at
// save time becomes the row's new `position`.

/** Move the item at index `from` to index `to`, shifting everything between.
 * A no-op (returns the same array reference) for an out-of-range or identity
 * move, so callers can skip a re-render/persist when nothing changed. */
export function moveArrayItem<T>(array: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= array.length || to < 0 || to >= array.length) {
    return array as T[];
  }
  const next = array.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Move the row with `id` to `toIndexWithinGroup` among only the rows sharing
 * its own group (as reported by `groupIdOf`) — every other row (in this group
 * or any other) keeps both its value and its absolute slot in `rows`. This is
 * what lets a category's tags be reordered independently: dragging tag #3 of
 * 40 in "Vocabulary" to the front never disturbs any other category's tags or
 * their interleaved absolute positions. A no-op (same reference) if the id
 * isn't found or the move doesn't change group-relative order. */
export function moveWithinGroup<T extends { id: string }>(
  rows: readonly T[],
  groupIdOf: (row: T) => string,
  id: string,
  toIndexWithinGroup: number,
): T[] {
  const target = rows.find((r) => r.id === id);
  if (!target) return rows as T[];
  const groupId = groupIdOf(target);

  const slots: number[] = [];
  const groupRows: T[] = [];
  rows.forEach((row, index) => {
    if (groupIdOf(row) === groupId) {
      slots.push(index);
      groupRows.push(row);
    }
  });

  const fromPos = groupRows.findIndex((r) => r.id === id);
  const toPos = Math.max(0, Math.min(toIndexWithinGroup, groupRows.length - 1));
  if (fromPos === toPos) return rows as T[];

  const reordered = moveArrayItem(groupRows, fromPos, toPos);
  const next = rows.slice();
  slots.forEach((slot, i) => {
    next[slot] = reordered[i];
  });
  return next;
}

/** Move the row with `id` to the very front or back of its own group — the
 * O(1) jump a teacher needs to promote/demote a tag in a category that has
 * too many entries for a one-step-at-a-time nudge to be practical. */
export function moveGroupItemToEdge<T extends { id: string }>(
  rows: readonly T[],
  groupIdOf: (row: T) => string,
  id: string,
  edge: "start" | "end",
): T[] {
  const target = rows.find((r) => r.id === id);
  if (!target) return rows as T[];
  const groupId = groupIdOf(target);
  const groupSize = rows.filter((r) => groupIdOf(r) === groupId).length;
  return moveWithinGroup(rows, groupIdOf, id, edge === "start" ? 0 : groupSize - 1);
}

/** Reassign the row with `id` to a different group, appending it to the END
 * of the whole array. Since nothing follows it globally, it necessarily lands
 * last among rows sharing its new group too — the simplest way to guarantee
 * "moved into this category → appears after this category's existing tags"
 * without needing to know that group's current slot layout. Mirrors how a
 * freshly-created row is already appended today. A no-op if the id isn't
 * found. */
export function reassignItemGroup<T extends { id: string }>(
  rows: readonly T[],
  id: string,
  newGroupId: string,
  setGroupId: (row: T, groupId: string) => T,
): T[] {
  const target = rows.find((r) => r.id === id);
  if (!target) return rows as T[];
  return [...rows.filter((r) => r.id !== id), setGroupId(target, newGroupId)];
}
