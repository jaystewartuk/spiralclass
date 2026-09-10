"use client";

import { useActionState, useState, type FormEvent } from "react";
import { hasFieldErrors, materialFieldMessages, validateMaterialFields } from "@spiralclass/shared";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "@/components/ui/field-error";
import { MaterialMetaFields } from "@/components/materials/material-meta-fields";
import { CLASS_CONTENT_MAX_CHARS, classContentLength } from "@/lib/materials/config";
import { saveMaterialContentAction, type SaveMaterialContentState } from "@/app/actions/library";
import type { FocusGroup } from "@/components/focus-tags/focus-tag-select";
import { useT } from "@/components/locale-provider";

type LevelOption = { id: string; label: string };

// "Write it myself" — the plain, always-available authoring path: type the
// body by hand, no AI involved. Saves with source="manual" through the exact
// same saveMaterialContentAction every other create sub-flow uses.
export function ManualCreateForm({
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
  const [body, setBody] = useState("");
  const toggleFocusTag = (id: string) =>
    setFocusTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const overLimit = classContentLength(body) > CLASS_CONTENT_MAX_CHARS;
  const { errors, setErrors, clearError } = useFieldErrors<"level" | "content">();

  function validateSubmit(e: FormEvent<HTMLFormElement>) {
    const fieldErrors = validateMaterialFields({
      levelId,
      hasBody: body.trim().length > 0,
      hasFile: false,
      linkUrl: "",
    });
    const msgs = materialFieldMessages(fieldErrors, t);
    setErrors({ level: msgs.level, content: msgs.content });
    if (hasFieldErrors(fieldErrors) || overLimit) e.preventDefault();
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
      <input type="hidden" name="source" value="manual" />
      <input type="hidden" name="body" value={body} />

      <MaterialMetaFields
        idPrefix="manual"
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

      <div className="space-y-1">
        <Label htmlFor="manual-body">
          {t("web.dashboard.classes.classContent.contentMarkdown")}
        </Label>
        <Textarea
          id="manual-body"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            clearError("content");
          }}
          rows={12}
          className="font-mono text-sm"
          placeholder={t("classContent.author.placeholder")}
        />
        <p
          className={
            "text-right text-xs " + (overLimit ? "text-destructive" : "text-muted-foreground")
          }
          aria-live="polite"
        >
          {classContentLength(body).toLocaleString()} / {CLASS_CONTENT_MAX_CHARS.toLocaleString()}
        </p>
      </div>

      <FieldError id="manual-content-error" message={errors.content} />
      {saveState?.error && <p className="text-sm text-destructive">{saveState.error}</p>}
      <Button type="submit" disabled={saving}>
        {saving ? t("web.materials.adding") : t("web.materials.saveMaterial")}
      </Button>
    </form>
  );
}
