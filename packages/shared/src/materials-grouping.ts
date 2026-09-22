// Category-based organization of materials, shared by every material list on
// both platforms (teacher library, student library, and the per-class lists).
//
// A material can carry tags across MANY categories (grammar + format + theme…).
// Showing the same item once under each of its categories makes a list noisy
// and hard to scan, so instead each material lands in exactly ONE "primary"
// category bucket: the highest-priority category — the smallest `position` in
// the teacher's own category order — among the categories its tags belong to.
// All of the material's tags still travel with it (rendered as chips by the
// caller), so no information is lost; only the bucketing is single-membership.
// Materials with no tags (or whose tags reference no known category) fall into
// a trailing "uncategorized" bucket.
//
// Pure and dependency-free (no DB, no React) so web and mobile share one
// organization and it unit-tests in isolation.

export type MaterialTag = { id: string; label: string; categoryId: string };

export type MaterialCategoryMeta = { id: string; label: string; position: number };

export type MaterialCategoryGroup<T> = {
  // null = the trailing "uncategorized" bucket.
  categoryId: string | null;
  categoryLabel: string;
  items: T[];
};

// Ranks a category by its teacher-defined position; unknown categories sort
// last. Ties (equal position, which the unique index should prevent) break by
// id so grouping is deterministic.
function categoryLess(a: MaterialCategoryMeta, b: MaterialCategoryMeta): boolean {
  if (a.position !== b.position) return a.position < b.position;
  return a.id < b.id;
}

export function groupMaterialsByCategory<T extends { tags: MaterialTag[] }>(
  items: T[],
  categories: MaterialCategoryMeta[],
  uncategorizedLabel: string,
): MaterialCategoryGroup<T>[] {
  const meta = new Map(categories.map((c) => [c.id, c]));

  // The material's primary category: the highest-priority category among the
  // categories its tags reference (ignoring tags whose category is unknown —
  // e.g. archived). Null when the material has no recognized-category tag.
  const primaryCategoryOf = (item: T): string | null => {
    let best: MaterialCategoryMeta | null = null;
    for (const tag of item.tags) {
      const cat = meta.get(tag.categoryId);
      if (!cat) continue;
      if (best === null || categoryLess(cat, best)) best = cat;
    }
    return best?.id ?? null;
  };

  const byCategory = new Map<string | null, T[]>();
  for (const item of items) {
    const key = primaryCategoryOf(item);
    const arr = byCategory.get(key);
    if (arr) arr.push(item);
    else byCategory.set(key, [item]);
  }

  const groups: MaterialCategoryGroup<T>[] = [];
  // Real categories in the teacher's own order — only those that got an item.
  const ordered = [...categories].sort((a, b) => (categoryLess(a, b) ? -1 : 1));
  for (const c of ordered) {
    const bucket = byCategory.get(c.id);
    if (bucket && bucket.length > 0) {
      groups.push({ categoryId: c.id, categoryLabel: c.label, items: bucket });
    }
  }
  // Trailing uncategorized bucket, only when non-empty.
  const uncategorized = byCategory.get(null);
  if (uncategorized && uncategorized.length > 0) {
    groups.push({ categoryId: null, categoryLabel: uncategorizedLabel, items: uncategorized });
  }
  return groups;
}
