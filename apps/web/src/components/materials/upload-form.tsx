"use client";

import { useActionState, useRef, useState, type FormEvent } from "react";
import { hasFieldErrors, materialFieldMessages, validateMaterialFields } from "@spiralclass/shared";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { MaterialMetaFields } from "@/components/materials/material-meta-fields";
import { saveMaterialContentAction, type SaveMaterialContentState } from "@/app/actions/library";
import type { FocusGroup } from "@/components/focus-tags/focus-tag-select";
import { useT } from "@/components/locale-provider";

type LevelOption = { id: string; label: string };

// "Upload file or link" — attach an existing file and/or a link, no body.
// Saves through saveMaterialContentAction's plain-attachment branch, same as
// every other create sub-flow.
export function UploadForm({
  levels,
  focusGroups,
  onSaved,
}: {
  levels: LevelOption[];
  focusGroups: FocusGroup[];
  onSaved: (result: { materialId: string; label: string | null }) => void;
}) {
  const t = useT();
  const [label, setLabel] = useState("");
  const [levelId, setLevelId] = useState<string>(levels[0]?.id ?? "");
  const [visibility, setVisibility] = useState("at_or_below");
  const [unit, setUnit] = useState("");
  const [focusTagIds, setFocusTagIds] = useState<Set<string>>(new Set());
  const [linkUrl, setLinkUrl] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toggleFocusTag = (id: string) =>
    setFocusTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const { errors, setErrors, clearError } = useFieldErrors<"level" | "content" | "linkUrl">();

  function validateSubmit(e: FormEvent<HTMLFormElement>) {
    const fieldErrors = validateMaterialFields({
      levelId,
      hasBody: false,
      hasFile: fileName !== null,
      linkUrl,
    });
    const msgs = materialFieldMessages(fieldErrors, t);
    setErrors({ level: msgs.level, content: msgs.content, linkUrl: msgs.linkUrl });
    if (hasFieldErrors(fieldErrors)) e.preventDefault();
  }

  const [saveState, saveAction, saving] = useActionState<SaveMaterialContentState, FormData>(
    async (prev, formData) => {
      const result = await saveMaterialContentAction(prev, formData);
      if (result?.ok && result.materialId)
        onSaved({ materialId: result.materialId, label: label || null });
      return result;
    },
    undefined,
  );

  return (
    <form action={saveAction} onSubmit={validateSubmit} className="space-y-4">
      <input type="hidden" name="levelId" value={levelId} />
      <input type="hidden" name="visibility" value={visibility} />
      <input type="hidden" name="focusTagIdsPresent" value="1" />
      {[...focusTagIds].map((id) => (
        <input key={id} type="hidden" name="focusTagId" value={id} />
      ))}

      <MaterialMetaFields
        idPrefix="upload"
        label={label}
        onLabelChange={setLabel}
        levelId={levelId}
        onLevelChange={(v) => {
          setLevelId(v);
          clearError("level");
        }}
        levels={levels}
        levelError={errors.level}
        visibility={visibility}
        onVisibilityChange={setVisibility}
        unit={unit}
        onUnitChange={setUnit}
        focusGroups={focusGroups}
        focusTagIds={focusTagIds}
        onToggleFocusTag={toggleFocusTag}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="upload-file">{t("web.materials.file")}</Label>
          <input
            id="upload-file"
            ref={fileInputRef}
            name="file"
            type="file"
            className="block w-full text-sm"
            onChange={(e) => {
              setFileName(e.target.files?.[0]?.name ?? null);
              clearError("content");
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="upload-link">{t("materials.link")}</Label>
          <Input
            id="upload-link"
            name="linkUrl"
            type="url"
            value={linkUrl}
            onChange={(e) => {
              setLinkUrl(e.target.value);
              clearError("content");
              clearError("linkUrl");
            }}
            placeholder={t("materials.linkPlaceholder")}
            invalid={Boolean(errors.linkUrl)}
            aria-describedby={errors.linkUrl ? "upload-link-error" : undefined}
          />
          <FieldError id="upload-link-error" message={errors.linkUrl} />
        </div>
      </div>

      <FieldError id="upload-content-error" message={errors.content} />
      {saveState?.error && <p className="text-destructive text-sm">{saveState.error}</p>}
      <Button type="submit" disabled={saving}>
        {saving ? t("web.materials.adding") : t("web.materials.saveMaterial")}
      </Button>
    </form>
  );
}
