"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FocusTagSelect, type FocusGroup } from "@/components/focus-tags/focus-tag-select";
import { useT } from "@/components/locale-provider";

type LevelOption = { id: string; label: string };

// Name / Level / Visibility / Unit / Tags — shared across all three
// create-material sub-flows (AI / manual / upload), each with helper copy so
// a first-time teacher knows what a field is for without guessing.
export function MaterialMetaFields({
  idPrefix,
  label,
  onLabelChange,
  levelId,
  onLevelChange,
  levels,
  levelError,
  visibility,
  onVisibilityChange,
  unit,
  onUnitChange,
  focusGroups,
  focusTagIds,
  onToggleFocusTag,
}: {
  idPrefix: string;
  label: string;
  onLabelChange: (value: string) => void;
  levelId: string;
  onLevelChange: (value: string) => void;
  levels: LevelOption[];
  levelError?: string;
  visibility: string;
  onVisibilityChange: (value: string) => void;
  unit: string;
  onUnitChange: (value: string) => void;
  focusGroups: FocusGroup[];
  focusTagIds: Set<string>;
  onToggleFocusTag: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-label`}>{t("web.materials.nameOptional")}</Label>
        <Input
          id={`${idPrefix}-label`}
          name="label"
          maxLength={80}
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder={t("web.materials.labelPlaceholder")}
        />
        <p className="text-xs text-muted-foreground">{t("web.materials.nameHelp")}</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {levels.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-level`}>{t("web.materials.level")}</Label>
            <Select value={levelId} onValueChange={onLevelChange}>
              <SelectTrigger
                id={`${idPrefix}-level`}
                aria-invalid={Boolean(levelError) || undefined}
              >
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
            <FieldError id={`${idPrefix}-level-error`} message={levelError} />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-visibility`}>{t("web.materials.whoSeesIt")}</Label>
          <Select value={visibility} onValueChange={onVisibilityChange}>
            <SelectTrigger id={`${idPrefix}-visibility`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="at_or_below">{t("web.materials.visibilityAtOrBelow")}</SelectItem>
              <SelectItem value="exact">{t("web.materials.visibilityExact")}</SelectItem>
              <SelectItem value="all">{t("web.materials.visibilityAll")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("web.materials.visibilityHelp")}</p>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-unit`}>{t("web.materials.unitOptional")}</Label>
        <Input
          id={`${idPrefix}-unit`}
          name="unit"
          maxLength={80}
          value={unit}
          onChange={(e) => onUnitChange(e.target.value)}
          placeholder={t("web.materials.unitPlaceholder")}
        />
        <p className="text-xs text-muted-foreground">{t("web.materials.unitHelp")}</p>
      </div>

      {focusGroups.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-tags`}>{t("web.materials.tagsOptional")}</Label>
          <FocusTagSelect
            id={`${idPrefix}-tags`}
            groups={focusGroups}
            selected={focusTagIds}
            onToggle={onToggleFocusTag}
          />
          <p className="text-xs text-muted-foreground">{t("web.materials.tagsHelp")}</p>
        </div>
      )}
    </div>
  );
}
