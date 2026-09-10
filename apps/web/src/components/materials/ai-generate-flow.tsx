"use client";

import { useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import {
  languageOptions,
  hasFieldErrors,
  materialFieldMessages,
  validateMaterialFields,
} from "@spiralclass/shared";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { Combobox } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ClassContentMarkdown } from "@/components/class-content/class-content-markdown";
import { FocusTagSelect, type FocusGroup } from "@/components/focus-tags/focus-tag-select";
import { ProLockNote } from "@/components/subscriptions/pro-lock-note";
import { MaterialMetaFields } from "@/components/materials/material-meta-fields";
import {
  refineMaterialDraftAction,
  saveMaterialContentAction,
  type RefineMaterialState,
  type SaveMaterialContentState,
} from "@/app/actions/library";
import { useT, useLocale } from "@/components/locale-provider";

type LevelOption = { id: string; label: string };
type Template = { id: string; label: string; body: string };

// Pre-generate guard, extracted so it's directly unit-testable — mirrors the
// server rule in prepareLibraryMaterialPrompt (lib/materials/handlers.ts): a
// topic OR at least one focus tag is required. A template alone doesn't
// satisfy the server rule, so it doesn't satisfy this guard either.
export function canGenerateMaterial(topic: string, focusTagCount: number): boolean {
  return topic.trim().length > 0 || focusTagCount > 0;
}

// "Generate with AI" — a focused 2-step sub-flow (Describe -> Review) around
// the existing streamed generation. Reuses generateStream()'s SSE parsing
// verbatim (moved out of material-form.tsx's aiStreamMode branch, unchanged)
// and saveMaterialContentAction for the actual save — this is a presentation
// redesign, not a new backend surface.
export function AiGenerateFlow({
  levels,
  focusGroups,
  templates,
  isPro,
  onSaved,
}: {
  levels: LevelOption[];
  focusGroups: FocusGroup[];
  templates: Template[];
  isPro: boolean;
  onSaved: (result: { materialId: string; label: string | null }) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [step, setStep] = useState<"describe" | "review">("describe");

  // ---------- describe (generation inputs) ----------
  const [topic, setTopic] = useState("");
  const [levelId, setLevelId] = useState<string>(levels[0]?.id ?? "");
  const [focusTagIds, setFocusTagIds] = useState<Set<string>>(new Set());
  const [genTemplateId, setGenTemplateId] = useState<string>(templates[0]?.id ?? "none");
  const [language, setLanguage] = useState<string>(locale === "en" ? "en" : "es");
  const toggleFocusTag = (id: string) =>
    setFocusTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const langOptions = useMemo(
    () =>
      languageOptions(locale, { generatableOnly: true }).map((l) => ({
        value: l.code,
        label: l.label,
      })),
    [locale],
  );

  const canGenerate = canGenerateMaterial(topic, focusTagIds.size);

  // Inline per-field validation (canonical form pattern, same as
  // manual-create-form.tsx / material-form.tsx): both submit buttons in this
  // flow stay enabled, and clicking with nothing filled in validates on
  // submit and surfaces a FieldError next to the offending control, instead
  // of the button silently doing nothing (a disabled button never fires a
  // click, so there was nothing to see or hear when everything was empty).
  const { errors, setErrors, clearError } = useFieldErrors<"topic" | "level" | "content">();
  useEffect(() => {
    if (canGenerate) clearError("topic");
  }, [canGenerate, clearError]);
  function validateGenerateSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canGenerate) {
      setErrors((prev) => ({ ...prev, topic: t("web.materials.guardHint") }));
      return;
    }
    void generateStream();
  }

  // ---------- review (streamed body + metadata + save) ----------
  const [body, setBody] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const DONE = "";

  async function generateStream() {
    streamAbort.current?.abort();
    const controller = new AbortController();
    streamAbort.current = controller;
    setStep("review");
    setStreaming(true);
    setStreamError(null);
    setBody("");
    try {
      const res = await fetch("/api/materials/generate/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          topic,
          levelId,
          focusTagIds: [...focusTagIds],
          templateId: genTemplateId === "none" ? null : genTemplateId,
          language,
          locale,
        }),
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => null)) as { message?: string } | null;
        setStreamError(err?.message ?? t("classContent.author.generateError"));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let bodyAcc = "";
      let completed = false;
      read: for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const text = JSON.parse(line.slice(line.indexOf(":") + 1).trimStart()) as string;
          if (text === DONE) {
            completed = true;
            break read;
          }
          bodyAcc += text;
          setBody(bodyAcc);
        }
      }
      if (!completed) setStreamError(t("classContent.author.generateError"));
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStreamError(t("classContent.author.generateError"));
      }
    } finally {
      setStreaming(false);
    }
  }

  const [instruction, setInstruction] = useState("");
  const [refineState, refineAction, refining] = useActionState<RefineMaterialState, FormData>(
    refineMaterialDraftAction,
    undefined,
  );
  useEffect(() => {
    if (refineState?.body) {
      setBody(refineState.body);
      setInstruction("");
    }
  }, [refineState?.body]);
  function triggerRefine() {
    if (!body.trim() || !instruction.trim() || refining) return;
    const fd = new FormData();
    fd.set("body", body);
    fd.set("instruction", instruction);
    fd.set("language", language);
    refineAction(fd);
  }

  const [label, setLabel] = useState("");
  const [visibility, setVisibility] = useState("at_or_below");
  const [unit, setUnit] = useState("");

  const [saveState, saveAction, saving] = useActionState<SaveMaterialContentState, FormData>(
    async (prev, formData) => {
      const result = await saveMaterialContentAction(prev, formData);
      if (result?.ok && result.materialId)
        onSaved({ materialId: result.materialId, label: label || null });
      return result;
    },
    undefined,
  );
  useEffect(() => {
    if (body.trim()) clearError("content");
  }, [body, clearError]);
  function validateSaveSubmit(e: FormEvent<HTMLFormElement>) {
    const fieldErrors = validateMaterialFields({
      levelId,
      hasBody: body.trim().length > 0,
      hasFile: false,
      linkUrl: "",
    });
    const msgs = materialFieldMessages(fieldErrors, t);
    setErrors((prev) => ({ ...prev, level: msgs.level, content: msgs.content }));
    if (hasFieldErrors(fieldErrors)) e.preventDefault();
  }

  return (
    <div className="space-y-4">
      {step === "describe" && (
        <form onSubmit={validateGenerateSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ai-topic">{t("classContent.author.generate")}</Label>
            <Input
              id="ai-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t("classContent.author.topicPlaceholder")}
              disabled={streaming}
              aria-invalid={Boolean(errors.topic) || undefined}
              aria-describedby={errors.topic ? "ai-topic-error" : undefined}
            />
            <FieldError id="ai-topic-error" message={errors.topic} />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {levels.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="ai-describe-level">{t("web.materials.level")}</Label>
                <Select value={levelId} onValueChange={setLevelId}>
                  <SelectTrigger id="ai-describe-level">
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
            )}
            <div className="space-y-1">
              <Label htmlFor="ai-language">{t("classContent.author.language")}</Label>
              <Combobox
                id="ai-language"
                options={langOptions}
                value={language}
                onValueChange={setLanguage}
                searchPlaceholder={t("classContent.author.languageSearch")}
                emptyText={t("classContent.author.languageEmpty")}
              />
            </div>
          </div>

          {templates.length > 0 && (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium">
                {t("classContent.author.structureLabel")}
              </p>
              <Select value={genTemplateId} onValueChange={setGenTemplateId}>
                <SelectTrigger className="w-full lg:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("classContent.author.structureNone")}</SelectItem>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>
                      {tpl.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {focusGroups.length > 0 && (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs font-medium">
                {t("classContent.author.focusLabel")}
              </p>
              <FocusTagSelect
                groups={focusGroups}
                selected={focusTagIds}
                onToggle={toggleFocusTag}
              />
            </div>
          )}

          {!isPro && <ProLockNote message={t("classContent.author.proRequired")} />}

          <Button type="submit" disabled={!isPro}>
            <Sparkles className="mr-1 size-4" aria-hidden />
            {t("classContent.author.generate")}
          </Button>
        </form>
      )}

      {step === "review" && (
        <div className="space-y-4">
          {streaming ? (
            <div className="min-h-40 rounded-md border px-3 py-3" aria-live="polite" aria-busy>
              <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs">
                <Sparkles className="text-primary size-3.5 animate-pulse" aria-hidden />
                {t("classContent.author.writing")}
              </p>
              {body.trim() ? <ClassContentMarkdown body={body} /> : null}
              <span
                className="bg-foreground ml-0.5 inline-block h-4 w-1.5 animate-pulse align-text-bottom"
                aria-hidden
              />
            </div>
          ) : (
            <>
              {streamError && <p className="text-destructive text-sm">{streamError}</p>}
              {body.trim() && (
                <div className="space-y-3">
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
                    <Sparkles className="text-primary size-3.5" aria-hidden />
                    {t("web.materials.reviewBanner")}
                  </p>
                  <div className="min-h-32 rounded-md border px-3 py-2">
                    <ClassContentMarkdown body={body} />
                  </div>
                  <div className="bg-muted/40 space-y-2 rounded-md border p-3">
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="text-primary size-4" aria-hidden />
                      <Label htmlFor="ai-refine-instruction">
                        {t("classContent.author.editWithAi")}
                      </Label>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {t("classContent.author.refineHint")}
                    </p>
                    <div className="flex gap-2">
                      <Input
                        id="ai-refine-instruction"
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            triggerRefine();
                          }
                        }}
                        placeholder={t("classContent.author.refineInstructionPlaceholder")}
                        disabled={refining}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={triggerRefine}
                        disabled={refining || !instruction.trim() || !isPro}
                      >
                        {refining
                          ? t("classContent.author.refining")
                          : t("classContent.author.editWithAi")}
                      </Button>
                    </div>
                    {!isPro && <ProLockNote message={t("classContent.author.proRequired")} />}
                    {refineState?.error && (
                      <p className="text-destructive text-sm">{refineState.error}</p>
                    )}
                  </div>
                </div>
              )}

              <form action={saveAction} onSubmit={validateSaveSubmit} className="space-y-4">
                <input type="hidden" name="levelId" value={levelId} />
                <input type="hidden" name="visibility" value={visibility} />
                <input type="hidden" name="focusTagIdsPresent" value="1" />
                {[...focusTagIds].map((id) => (
                  <input key={id} type="hidden" name="focusTagId" value={id} />
                ))}
                <input type="hidden" name="source" value="ai" />
                <input type="hidden" name="body" value={body} />

                <MaterialMetaFields
                  idPrefix="ai-review"
                  label={label}
                  onLabelChange={setLabel}
                  levelId={levelId}
                  onLevelChange={(v) => {
                    setLevelId(v);
                    clearError("level");
                  }}
                  levelError={errors.level}
                  levels={levels}
                  visibility={visibility}
                  onVisibilityChange={setVisibility}
                  unit={unit}
                  onUnitChange={setUnit}
                  focusGroups={focusGroups}
                  focusTagIds={focusTagIds}
                  onToggleFocusTag={toggleFocusTag}
                />

                <FieldError id="ai-review-content-error" message={errors.content} />
                {saveState?.error && <p className="text-destructive text-sm">{saveState.error}</p>}
                <Button type="submit" disabled={saving}>
                  {saving ? t("web.materials.adding") : t("web.materials.saveMaterial")}
                </Button>
              </form>
            </>
          )}
        </div>
      )}
    </div>
  );
}
