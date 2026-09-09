import Link from "next/link";
import { ArrowRight, Layers, Library } from "lucide-react";
import type { LevelRow } from "@/lib/levels";
import { materialsAllLevelsHref, materialsLevelHref } from "@/lib/library/materials-href";
import { getT } from "@/lib/i18n";

// The Materials landing view: pick a level, then work inside it.
//
// Observed workflow: a teacher thinks "what do I have for
// A2?" first and only then narrows by category/type — but the page opened on
// every material at once with level demoted to the third of four filter chip
// rows, defaulting to "All". This puts the mandatory, single-valued, ordered
// axis first and leaves every other axis exactly where it was, one level in.
//
// Deliberately NOT folders: nothing is stored or moved here. Each card is a
// view over `LibraryMaterial.levelId`, which every material already carries, so
// re-tagging a material to B1 re-homes it with no drag, no empty folder, and no
// loss of its cross-cutting focus tags.
//
// No per-level counts, by explicit request from the teacher this was designed
// with — she asked for the cleaner view. That's also why this renders with zero
// material queries: the hub costs one already-loaded level list and mints no
// signed URLs at all, so landing on Materials is now cheaper than it was.
export async function LevelHub({
  levels,
  showAllLevels,
}: {
  levels: LevelRow[];
  // False for a brand-new library — "browse everything" is noise when there is
  // nothing to browse, and the page's own empty state says something useful.
  showAllLevels: boolean;
}) {
  const t = await getT();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">{t("web.materials.hubTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("web.materials.hubDescription")}</p>
      </div>

      {/* Four across on a wide screen rather than three: the six CEFR levels
          every teacher is seeded with then land as 4 + 2 instead of 3 + 3, so
          the row that is short is short by less, and each card gets a size
          that suits its one short label instead of a third of the page. */}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {levels.map((level) => (
          <li key={level.id}>
            <Link
              href={materialsLevelHref(level.id)}
              aria-label={t("web.materials.openLevel", { level: level.label })}
              className="group flex h-full items-center gap-3 rounded-lg border bg-card p-4 shadow-sm transition-colors hover:border-foreground/30 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-info-bg text-info">
                <Layers className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 text-base font-medium">{level.label}</span>
              {/* Decorative: the whole card is the link and its accessible name
                  already says "Open level A2". This only tells a sighted
                  teacher that the card goes somewhere. */}
              <ArrowRight
                className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>

      {showAllLevels && (
        <Link
          href={materialsAllLevelsHref()}
          className="group flex items-center gap-3 rounded-lg border border-dashed p-4 transition-colors hover:border-foreground/30 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <Library className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("web.materials.allLevels")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("web.materials.allLevelsHint")}
            </span>
          </span>
          <ArrowRight
            className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>
      )}
    </div>
  );
}
