"use client";

import { useActionState, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FocusTagSelect, type FocusGroup } from "@/components/focus-tags/focus-tag-select";
import { updateLibraryMaterialAction, type LibraryState } from "@/app/actions/library";
import { useT } from "@/components/locale-provider";

// Phase 3 — edit an existing library item's details (name, unit, visibility,
// level, and — gap G1 — tags). The attachment isn't editable here; replacing
// a file/link stays a delete-and-re-add. Renders as an inline "Edit" toggle
// next to each item.

type LevelOption = { id: string; label: string };

type MaterialDetails = {
  id: string;
  levelId: string;
  visibility: string;
  label: string | null;
  unit: string | null;
  focusTagIds: string[];
};

export function LibraryEditForm({
  material,
  levels,
  focusGroups = [],
}: {
  material: MaterialDetails;
  levels: LevelOption[];
  focusGroups?: FocusGroup[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [levelId, setLevelId] = useState<string>(material.levelId);
  const [visibility, setVisibility] = useState<string>(material.visibility);
  const [focusTagIds, setFocusTagIds] = useState<Set<string>>(() => new Set(material.focusTagIds));
  const toggleFocusTag = (id: string) =>
    setFocusTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [state, formAction, pending] = useActionState<LibraryState, FormData>(
    async (prev, formData) => {
      const result = await updateLibraryMaterialAction(prev, formData);
      if (result?.ok) setOpen(false);
      return result;
    },
    undefined,
  );

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-4" aria-hidden />
        {t("common.edit")}
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      className="order-last mt-2 w-full space-y-3 rounded-md border bg-muted/40 p-3"
    >
      <input type="hidden" name="materialId" value={material.id} />
      <input type="hidden" name="levelId" value={levelId} />
      <input type="hidden" name="visibility" value={visibility} />
      {focusGroups.length > 0 && <input type="hidden" name="focusTagIdsPresent" value="1" />}
      {[...focusTagIds].map((id) => (
        <input key={id} type="hidden" name="focusTagId" value={id} />
      ))}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`editLevel-${material.id}`}>{t("web.materials.level")}</Label>
          <Select value={levelId} onValueChange={setLevelId}>
            <SelectTrigger id={`editLevel-${material.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {levels.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`editVisibility-${material.id}`}>{t("web.materials.whoSeesIt")}</Label>
          <Select value={visibility} onValueChange={setVisibility}>
            <SelectTrigger id={`editVisibility-${material.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="at_or_below">{t("web.materials.visibilityAtOrBelow")}</SelectItem>
              <SelectItem value="exact">{t("web.materials.visibilityExact")}</SelectItem>
              <SelectItem value="all">{t("web.materials.visibilityAll")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`editLabel-${material.id}`}>{t("web.materials.nameOptional")}</Label>
        <Input
          id={`editLabel-${material.id}`}
          name="label"
          maxLength={80}
          defaultValue={material.label ?? ""}
          placeholder={t("web.materials.labelPlaceholder")}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor={`editUnit-${material.id}`}>{t("web.materials.unitOptional")}</Label>
        <Input
          id={`editUnit-${material.id}`}
          name="unit"
          maxLength={80}
          defaultValue={material.unit ?? ""}
          placeholder={t("web.materials.unitPlaceholder")}
        />
      </div>

      {focusGroups.length > 0 && (
        <div className="space-y-1">
          <Label>{t("web.materials.tagsOptional")}</Label>
          <FocusTagSelect groups={focusGroups} selected={focusTagIds} onToggle={toggleFocusTag} />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t("web.studentLevel.saving") : t("common.save")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </Button>
      </div>

      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
