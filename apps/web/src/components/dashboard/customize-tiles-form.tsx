"use client";

import { startTransition, useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import {
  saveDashboardTilesAction,
  type TeacherPrefsActionState,
} from "@/app/actions/teacher-account";
import { navItem, navLabel, type DashboardTilePref, type NavLocale } from "@spiralclass/shared";

// Reorder/hide form for the dashboard "Day to day" tile grid. No drag-and-drop
// dependency — up/down buttons keep this keyboard- and screen-reader-friendly
// and match the rest of the settings surface's low-tech-first bar.

export function CustomizeDashboardTilesForm({
  tiles: initialTiles,
  locale,
}: {
  tiles: DashboardTilePref[];
  locale: NavLocale;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<TeacherPrefsActionState, FormData>(
    saveDashboardTilesAction,
    undefined,
  );
  const [tiles, setTiles] = useState<DashboardTilePref[]>(initialTiles);

  function move(index: number, direction: -1 | 1) {
    setTiles((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function toggleHidden(key: DashboardTilePref["key"]) {
    setTiles((prev) => prev.map((t) => (t.key === key ? { ...t, hidden: !t.hidden } : t)));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData();
    formData.set("tiles", JSON.stringify(tiles));
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <ul className="divide-y rounded-md border">
        {tiles.map((tile, index) => {
          const item = navItem(tile.key);
          return (
            <li key={tile.key} className="flex items-center gap-3 px-3 py-2">
              <div className="flex flex-col">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={t("web.customizeTiles.moveUp")}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  disabled={index === tiles.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={t("web.customizeTiles.moveDown")}
                >
                  ↓
                </Button>
              </div>
              <Label
                htmlFor={`tile-${tile.key}`}
                className={
                  tile.hidden ? "flex-1 font-normal text-muted-foreground" : "flex-1 font-normal"
                }
              >
                {navLabel(item, locale)}
              </Label>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`tile-${tile.key}`}
                  checked={!tile.hidden}
                  onCheckedChange={() => toggleHidden(tile.key)}
                />
                <span className="text-xs text-muted-foreground">
                  {tile.hidden ? t("web.customizeTiles.hidden") : t("web.customizeTiles.shown")}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t("web.customizeTiles.saving") : t("web.customizeTiles.saveOrder")}
        </Button>
        <FormStatus state={state} savedMessage={t("web.customizeTiles.saved")} />
      </div>
    </form>
  );
}
