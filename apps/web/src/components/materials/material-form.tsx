"use client";

import { useActionState, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { AiChangeChip } from "@/components/materials/ai-change-chip";
import { Copy, Check, Sparkles, Mic } from "lucide-react";
import {
  hasFieldErrors,
  languageOptions,
  materialFieldMessages,
  materialSaveStatus,
  validateMaterialFields,
  usesEnglishCopy,
} from "@spiralclass/shared";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { Combobox } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible } from "@/components/ui/collapsible";
import { FieldError } from "@/components/ui/field-error";
import { FormStatus } from "@/components/ui/form-status";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MaterialEditor } from "@/components/materials/material-editor";
import {
  MaterialPodcastSection,
  type PodcastInitial,
} from "@/components/materials/material-podcast-section";
import { FocusTagSelect, type FocusGroup } from "@/components/focus-tags/focus-tag-select";
import { ProLockNote } from "@/components/subscriptions/pro-lock-note";
import { CLASS_CONTENT_MAX_CHARS, classContentLength } from "@/lib/materials/config";
import {
  deleteClassContentTemplateAction,
  saveClassContentTemplateAction,
  type SaveTemplateState,
} from "@/app/actions/class-content";
import {
  generateMaterialDraftAction,
  refineMaterialDraftAction,
  restoreMaterialRevisionAction,
  saveContentToLibraryAction,
  saveMaterialContentAction,
  snapshotRefineCheckpointAction,
  type GenerateMaterialState,
  type LibraryState,
  type RefineMaterialState,
  type RestoreMaterialRevisionState,
  type SaveMaterialContentState,
} from "@/app/actions/library";
import { useT, useLocale } from "@/components/locale-provider";
import {
  useUnsavedChangesGuard,
  type MaterialDraftSnapshot,
} from "@/lib/use-unsaved-changes-guard";

// The unified material form (docs/features/library-materials.md) — one form,
// three content types, used both on the standalone library page (scope
// "library") and the class detail page (scope "booking"). "Write" saves a
// body (create or edit in place, with AI-generate + templates + version
// history); "File"/"Link" are attachments (always create — replacing one is
// delete-and-re-add, matching the library's existing convention). Level +
// visibility only make sense for a reusable library item; send-timing only
// for a booking-scoped attachment.

export type ContentType = "write" | "file" | "link";
export type ClassContentSource = "manual" | "ai";
type Template = { id: string; label: string; body: string };
type Revision = { id: string; body: string; source: ClassContentSource; createdAt: Date };
type LevelOption = { id: string; label: string };

// Lesson continuity: a previous class's material a teacher can pick as
// "continue from" context (web sibling of ContinuationCandidate,
// @spiralclass/shared) — booking scope only.
export type ContinuationCandidate = {
  materialId: string;
  bookingId: string;
  label: string | null;
  scheduledStart: string;
  preview: string;
};

export type ExistingContentMaterial = {
  id: string;
  body: string;
  source: ClassContentSource;
  // Library scope only — a booking's class content has no level/visibility/
  // label/tags of its own, so these stay undefined there.
  label?: string | null;
  levelId?: string;
  visibility?: string;
  focusTagIds?: string[];
  // A content material can also carry a link and/or file on the same row.
  // `linkUrl` MUST round-trip through this type: the save action reads a
  // present-but-empty `linkUrl` field as "clear it", so a form that renders
  // the link input without seeding it deletes the material's link on every
  // save. `storagePath` is display-only (the file input can't be re-seeded).
  linkUrl?: string | null;
  storagePath?: string | null;
  // Current podcast state for this saved material, if any — seeds the podcast
  // section so a ready podcast shows its player immediately without a poll.
  podcast?: PodcastInitial;
};

export function MaterialForm({
  scope,
  bookingId,
  levels = [],
  focusGroups = [],
  templates: initialTemplates = [],
  revisions = [],
  continuationCandidates = [],
  aiEnabled,
  isPro,
  podcastEnabled = false,
  existing,
  onSaved,
  onCancel,
}: {
  scope: "library" | "booking";
  bookingId?: string;
  levels?: LevelOption[];
  focusGroups?: FocusGroup[];
  templates?: Template[];
  revisions?: Revision[];
  // Booking scope only: this student's other classes with body-bearing
  // content, offered as "continue from" context for the AI generate form
  // (lesson continuity).
  continuationCandidates?: ContinuationCandidate[];
  aiEnabled: boolean;
  // Whether the acting teacher's plan grants AI authoring (entitlementsFor's
  // canScheduleMaterials — class_content rides the same Pro entitlement).
  // `aiEnabled` alone (platform creds configured) is NOT enough to let a Free
  // teacher submit a generate/refine request — this is the proactive
  // client-side mirror of the gateProFeature("class_content") server check,
  // so the control is disabled with an explanation instead of failing after
  // submit. The server check remains authoritative; this only improves UX.
  isPro: boolean;
  // Whether podcast generation is available (platform TTS + LLM creds present).
  // When false the podcast section is hidden entirely — graceful degrade.
  podcastEnabled?: boolean;
  // Set = editing this content material's body in place. Only ever a
  // "write" material — file/link stay delete-and-re-add.
  existing?: ExistingContentMaterial;
  onSaved?: () => void;
  // Renders a Cancel in the pinned action bar (the inline library edit card
  // passes it to close the row without saving) — mirrors mobile's onCancel.
  onCancel?: () => void;
}) {
  const t = useT();
  const isBooking = scope === "booking";
  // Kept in a ref (not a dependency) so the attach-success effect below can
  // call the latest callback without re-running just because the parent
  // passed a new function identity.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // ---------- shared fields ----------
  const [label, setLabel] = useState(existing?.label ?? "");
  const [levelId, setLevelId] = useState<string>(existing?.levelId ?? levels[0]?.id ?? "");
  const [visibility, setVisibility] = useState(existing?.visibility ?? "at_or_below");
  const [focusTagIds, setFocusTagIds] = useState<Set<string>>(new Set(existing?.focusTagIds ?? []));

  // ---------- file + link pieces (present alongside the body on one row) ----------
  // Controlled so the save button can enable on a file/link even without a body,
  // and clear after a successful save. The file input stays uncontrolled (React
  // can't set its value) — we only track whether one is chosen. Seeding from
  // `existing` is load-bearing: the save action treats a present-but-empty
  // linkUrl as "clear it", so an unseeded input silently deletes the link.
  const [linkUrl, setLinkUrl] = useState(existing?.linkUrl ?? "");
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toggleFocusTag = (id: string) =>
    setFocusTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ---------- "write" tab ----------
  const [body, setBody] = useState(existing?.body ?? "");
  const [source, setSource] = useState<ClassContentSource>(existing?.source ?? "manual");
  // The body/source immediately before the most recent AI change (whole-document
  // "Edit with AI", or a per-section refine bubbling up from MaterialEditor's
  // onChange below) — backs the one-click "Undo AI change" banner. Cleared once
  // acted on or once a save makes the AI change the new saved baseline (Version
  // History is the tool for going further back after that point). A per-section
  // refine also gets its OWN local undo inside MaterialEditor (material-editor.tsx);
  // this is the whole-document-level equivalent, which that editor doesn't have —
  // adopting an externally-changed body (see editor.ts's `adoptBody`) drops its
  // in-session undo stack rather than special-casing a refine's previous state.
  const [lastAiChange, setLastAiChange] = useState<{
    body: string;
    source: ClassContentSource;
  } | null>(null);
  // "Edit with AI" instruction — the free-text change the teacher asks for. The
  // raw-Markdown textarea is gone (D-73): the body renders read-only and every
  // change to it goes through the AI refine control below (or a full regenerate
  // / version-history restore). This kills hand-typed Markdown syntax errors.
  const [instruction, setInstruction] = useState("");
  const [topic, setTopic] = useState("");
  const [copied, setCopied] = useState(false);
  const [templateList, setTemplateList] = useState<Template[]>(initialTemplates);
  const [genTemplateId, setGenTemplateId] = useState<string>(templateList[0]?.id ?? "none");
  // Lesson continuity: previous-class materials picked as "continue from"
  // context for the next generation. Booking scope only.
  const [continueFromIds, setContinueFromIds] = useState<Set<string>>(new Set());
  const toggleContinueFrom = (id: string) =>
    setContinueFromIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Generated / refined bodies are server-sliced to the ceiling, but a restored
  // revision could sit right at it — keep the save-button guard against a body
  // that would fail server validation.
  const overLimit = classContentLength(body) > CLASS_CONTENT_MAX_CHARS;
  // A material is saveable once it carries any of its three pieces.
  const canSave = body.trim().length > 0 || fileName !== null || linkUrl.trim().length > 0;

  // Inline per-field validation (canonical form pattern): the save button stays
  // enabled and we validate on submit, pointing at the offending field, instead
  // of silently disabling the button with no explanation. React 19 form actions
  // honour preventDefault in onSubmit, so an invalid form never dispatches the
  // server action. `content` is a synthetic field rendered by the file/link row.
  const { errors, setErrors, clearError } = useFieldErrors<"level" | "content" | "linkUrl">();

  // The save form is submitted from the pinned action bar OUTSIDE it, via the
  // button's `form=` association. The id must be per-instance — the library
  // list mounts one MaterialForm per row, so a static id would collide.
  const reactId = useId();
  const formId = `material-save-${reactId}`;
  const saveFormRef = useRef<HTMLFormElement | null>(null);

  function validateMaterialSubmit(e: FormEvent<HTMLFormElement>) {
    const fieldErrors = validateMaterialFields({
      levelId,
      hasBody: body.trim().length > 0,
      hasFile: fileName !== null,
      linkUrl,
      // Booking-scope materials attach to one class and carry no level input.
      requireLevel: !isBooking,
    });
    const msgs = materialFieldMessages(fieldErrors, t);
    setErrors({ level: msgs.level, content: msgs.content, linkUrl: msgs.linkUrl });
    // overLimit already turns the character counter red; block the submit too.
    if (hasFieldErrors(fieldErrors) || overLimit) {
      e.preventDefault();
      // With Save pinned at the bottom, the offending field can be scrolled
      // far away — bring the first invalid one back. Scoped to THIS form's
      // element (field ids are static strings duplicated across the N forms
      // the library list mounts, so never getElementById), and deferred a
      // microtask so the setErrors render has painted aria-invalid.
      queueMicrotask(() => {
        saveFormRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }
  // A body (manual or AI-generated), file, or link all satisfy the "needs
  // content" rule — clear that error the moment any piece appears, regardless
  // of which control produced it (the AI-set body paths don't touch an input).
  useEffect(() => {
    if (canSave) clearError("content");
  }, [canSave, clearError]);

  // The file+link cluster collapses behind a disclosure. Controlled, because
  // a validation error inside a collapsed section must never stay hidden —
  // an errored submit forces it open. Starts open on create (attaching is a
  // primary path there) and whenever the material already carries a piece.
  const [attachOpen, setAttachOpen] = useState(
    !existing || Boolean(existing.linkUrl) || Boolean(existing.storagePath),
  );
  useEffect(() => {
    if (errors.linkUrl || errors.content) setAttachOpen(true);
  }, [errors.linkUrl, errors.content]);

  function clearPieces() {
    setLinkUrl("");
    setFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — no-op, the textarea is still selectable by hand.
    }
  }

  const [genState, genAction, generating] = useActionState<GenerateMaterialState, FormData>(
    generateMaterialDraftAction,
    undefined,
  );
  useEffect(() => {
    if (genState?.body) {
      setBody(genState.body);
      setSource("ai");
    }
  }, [genState?.body]);

  // "Edit with AI" — apply the teacher's instruction to the current body and
  // swap in the revised Markdown. Dispatched directly (not via a nested <form>,
  // which the surrounding save form forbids) so the control can live beside the
  // read-only preview.
  const [refineState, refineAction, refining] = useActionState<RefineMaterialState, FormData>(
    refineMaterialDraftAction,
    undefined,
  );
  useEffect(() => {
    if (refineState?.body) {
      // Capture the pre-refine state for the "Undo AI change" banner and
      // checkpoint it to Version History — both read `body`/`source` as they
      // stood BEFORE this refine (the closure over this render, prior to the
      // setBody/setSource calls below). Best-effort/fire-and-forget: it must
      // never block or fail the refine the teacher is already looking at.
      setLastAiChange({ body, source });
      if (existing?.id) {
        void snapshotRefineCheckpointAction({ materialId: existing.id, body, source });
      }
      setBody(refineState.body);
      setSource("ai");
      setInstruction("");
    }
  }, [refineState?.body]);

  const locale = useLocale();

  // The language the material is WRITTEN IN — a registry code, not the subject
  // it teaches (that comes from the teacher's target_language, server-side).
  // Shared by both branches below: every AI compose surface offers it, streamed
  // or not. Defaults from the UI locale, which is only a guess at what she
  // writes in; `teachers.teaching_language` would be the better default.
  const [language, setLanguage] = useState<string>(usesEnglishCopy(locale) ? "en" : "es");
  // `generatableOnly`: this picker feeds a Claude prompt, and the registry spans
  // every ISO 639-1 language — including extinct ones (Avestan) and very
  // low-resource ones the model would produce unusable material in. Teaching
  // those is still fully supported; only the "let Claude draft it" shortcut is
  // gated. See the `gen` flag in @spiralclass/shared's languages.ts.
  const langOptions = useMemo(
    () =>
      languageOptions(locale, { generatableOnly: true }).map((l) => ({
        value: l.code,
        label: l.label,
      })),
    [locale],
  );

  const [saveState, saveAction, saving] = useActionState<SaveMaterialContentState, FormData>(
    async (prev, formData) => {
      const result = await saveMaterialContentAction(prev, formData);
      if (result?.ok && !existing) {
        // Fresh create — clear the draft so the form is ready for the next one.
        setBody("");
        setLabel("");
        setTopic("");
        setInstruction("");
        setFocusTagIds(new Set());
        clearPieces();
        onSaved?.();
      }
      return result;
    },
    undefined,
  );

  // Unsaved-changes guard over the FULL draft (not just body/source — a
  // level, tag or link edit is just as lost on navigate-away). The hook
  // baselines on the first render's snapshot, which is these useState
  // initializers by construction, so it can't report dirty on mount.
  const draftSnapshot: MaterialDraftSnapshot = {
    body,
    source,
    label,
    linkUrl,
    // Library scope only — a booking material posts none of these, and a
    // field that can't save can't be "unsaved".
    ...(isBooking ? {} : { levelId, visibility, focusTagIds: [...focusTagIds] }),
  };
  const { dirty, markSaved } = useUnsavedChangesGuard(draftSnapshot);
  const draftRef = useRef(draftSnapshot);
  draftRef.current = draftSnapshot;
  useEffect(() => {
    if (saveState?.ok) {
      markSaved(draftRef.current);
      // The AI change is now the saved baseline — Version History (backed by
      // the refine-time checkpoint above) is the tool for going further back
      // from here, not this one-shot banner.
      setLastAiChange(null);
    }
  }, [saveState, markSaved]);

  function handleTplSubmit(e: FormEvent<HTMLFormElement>) {
    if (!templateLabel.trim()) {
      e.preventDefault();
      setTemplateLabelError(t("classContent.author.templateNameRequired"));
    }
  }
  const [templateLabel, setTemplateLabel] = useState("");
  const [templateLabelError, setTemplateLabelError] = useState<string | undefined>(undefined);
  const [tplState, tplAction, savingTemplate] = useActionState<SaveTemplateState, FormData>(
    saveClassContentTemplateAction,
    undefined,
  );
  useEffect(() => {
    if (tplState?.ok && tplState.template) {
      setTemplateList((prev) => [...prev, tplState.template!]);
      setTemplateLabel("");
    }
  }, [tplState]);

  function applyTemplate(tpl: Template) {
    setBody(tpl.body);
    setSource("manual");
  }

  async function removeTemplate(id: string) {
    setTemplateList((prev) => prev.filter((tpl) => tpl.id !== id));
    const fd = new FormData();
    fd.set("templateId", id);
    await deleteClassContentTemplateAction(fd);
  }

  // "Save to library" (booking scope only) — copies the current draft into
  // the reusable library as a brand-new item; never edits anything in place.
  const [libLevel, setLibLevel] = useState<string>("");
  const [libLevelError, setLibLevelError] = useState<string | undefined>(undefined);
  const [libState, libAction, savingToLib] = useActionState<LibraryState, FormData>(
    saveContentToLibraryAction,
    undefined,
  );
  function handleLibSubmit(e: FormEvent<HTMLFormElement>) {
    if (!libLevel) {
      e.preventDefault();
      setLibLevelError(t("classContent.author.pickLevel"));
    }
  }

  const [revisionList] = useState<Revision[]>(revisions);
  const [restoreState, restoreAction, restoring] = useActionState<
    RestoreMaterialRevisionState,
    FormData
  >(restoreMaterialRevisionAction, undefined);
  useEffect(() => {
    if (restoreState?.ok && restoreState.body !== undefined) {
      setBody(restoreState.body);
      setSource(restoreState.source ?? "manual");
      markSaved({
        ...draftRef.current,
        body: restoreState.body,
        source: restoreState.source ?? "manual",
      });
    }
  }, [restoreState, markSaved]);

  // ---------- "file"/"link" tabs ----------
  // "confirmation" = visible as soon as the class is confirmed (materialSendTime
  // Elapsed treats it as always-elapsed). Defaulting here — instead of the old
  // "24h before" — stops a teacher who doesn't touch the timing from silently
  // hiding a class material from the student until the day before.
  const [sendTiming, setSendTiming] = useState<string>(isBooking ? "confirmation" : "always");

  const saveLabel = existing
    ? saving
      ? t("classContent.author.saving")
      : t("classContent.author.save")
    : saving
      ? t("web.materials.adding")
      : t("web.materials.addMaterial");

  // The one status line the pinned bar shows. `dirty` outranking a stale
  // `savedOk` IS the "clear the old Saved message on the next edit" behaviour
  // — no extra state, no effect (materialSaveStatus, @spiralclass/shared).
  const saveStatus = materialSaveStatus({
    saving,
    dirty,
    savedOk: Boolean(saveState?.ok && !saveState.error),
  });

  function triggerRefine() {
    if (!body.trim() || !instruction.trim() || refining) return;
    const fd = new FormData();
    fd.set("body", body);
    fd.set("instruction", instruction);
    fd.set("language", language);
    refineAction(fd);
  }

  // Reverts the whole-document "Edit with AI" box's most recent change — the
  // one-click recovery the reported bug asked for. Restoring an old Version
  // History revision already goes through the normal save path (itself
  // snapshotted, reversible both ways); this is the pre-save, same-session
  // equivalent for the case that's fastest to reach for.
  function undoLastAiChange() {
    if (!lastAiChange) return;
    setBody(lastAiChange.body);
    setSource(lastAiChange.source);
    setLastAiChange(null);
  }

  // The body, as section cards the teacher can restructure directly — the
  // raw-Markdown textarea is gone (D-73) and, as of MATERIAL_EDITING phase 2,
  // the read-only preview it left behind is an editor. Each card is rendered by
  // the same MaterialDocument renderer the student sees, so this IS the preview;
  // move/duplicate/delete/add and per-section AI refine ride on top of it, all
  // through the shared section ops. Empty → nothing (the generate control
  // carries the empty state). Contains no form controls that post, so it stays
  // safe inside the save form.
  const bodyEditor = body.trim() ? (
    <MaterialEditor
      body={body}
      onChange={(next, opts) => {
        // A section refine is AI-authored content, exactly like a
        // whole-document one; a pure structural edit leaves the source as it is.
        // No `lastAiChange` banner here — MaterialEditor already shows its own
        // prominent "Undo AI change" affordance for a section refine, backed by
        // its local undo stack; this would just be a second one saying the same
        // thing. The Version History checkpoint still applies either way (`body`/
        // `source` here are this render's PRE-refine closure, same as the
        // whole-document effect above).
        if (opts?.aiEdited) {
          setSource("ai");
          if (existing?.id) {
            void snapshotRefineCheckpointAction({ materialId: existing.id, body, source });
          }
        }
        setBody(next);
      }}
      canRefine={aiEnabled && isPro}
      language={language}
    />
  ) : null;

  // The body opens expanded in every case. It used to collapse when editing
  // an existing material "so Save is reachable without scrolling past a long
  // body" — that was a workaround for Save living under the body, which the
  // pinned action bar has since fixed; and preview-first block editing keeps
  // the open body roughly the material's own length anyway. The disclosure
  // itself stays, as a manual fold.
  const contentDefaultOpen = true;

  // Shared copy control — sits in the collapsible header in both branches.
  const copyButton = body.trim() ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={copyBody}
      aria-label={t("classContent.author.copy")}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      <span className="ml-1">
        {copied ? t("classContent.author.copied") : t("classContent.author.copy")}
      </span>
    </Button>
  ) : null;

  // "Edit with AI" — the replacement for hand-editing Markdown. The instruction
  // field has no `name` (never submitted with the save form) and its Enter key
  // triggers a refine instead of submitting the surrounding form.
  const editWithAi = body.trim() ? (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center gap-1.5">
        <Sparkles className="size-4 text-primary" aria-hidden />
        <Label htmlFor="refine-instruction">{t("classContent.author.editWithAi")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("classContent.author.refineHint")}</p>
      <div className="flex gap-2">
        <Input
          id="refine-instruction"
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
          {!refining && <Sparkles className="mr-1 size-4" aria-hidden />}
          {refining ? t("classContent.author.refining") : t("classContent.author.editWithAi")}
        </Button>
      </div>
      {!isPro && <ProLockNote message={t("classContent.author.proRequired")} />}
      {refineState?.error && <p className="text-sm text-destructive">{refineState.error}</p>}
      {lastAiChange && (
        <AiChangeChip>
          {t("classContent.author.aiChangeApplied")}
          <Button type="button" variant="ghost" size="sm" onClick={undoLastAiChange}>
            {t("material.editor.undoAiChange")}
          </Button>
        </AiChangeChip>
      )}
    </div>
  ) : null;

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        {templateList.length > 0 && (
          <div className="space-y-1.5 rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              {t("classContent.author.startFromTemplate")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {templateList.map((tpl) => (
                <div
                  key={tpl.id}
                  className="flex items-center gap-1 rounded-full border bg-background"
                >
                  <button
                    type="button"
                    onClick={() => applyTemplate(tpl)}
                    className="rounded-full px-2.5 py-1 text-xs hover:bg-accent"
                  >
                    {tpl.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeTemplate(tpl.id)}
                    aria-label={t("web.dashboard.classes.classContent.deleteTemplate", {
                      label: tpl.label,
                    })}
                    className="pr-2 text-xs text-muted-foreground hover:text-destructive"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {aiEnabled && (
          // Titled createWithAi, NOT the generate key — the submit button
          // inside carries that text, and a test targeting the button by text
          // must never match the header.
          <Collapsible title={t("classContent.author.createWithAi")} defaultOpen={!existing}>
            <form action={genAction} className="space-y-2 rounded-md border bg-muted/40 p-3">
              {bookingId && <input type="hidden" name="bookingId" value={bookingId} />}
              {!isBooking && <input type="hidden" name="levelId" value={levelId} />}
              {[...focusTagIds].map((id) => (
                <input key={id} type="hidden" name="focusTagId" value={id} />
              ))}
              <input
                type="hidden"
                name="templateId"
                value={genTemplateId === "none" ? "" : genTemplateId}
              />
              {[...continueFromIds].map((id) => (
                <input key={id} type="hidden" name="continueFromMaterialId" value={id} />
              ))}
              <div className="space-y-1">
                <Label htmlFor="gen-language">{t("classContent.author.language")}</Label>
                <Combobox
                  id="gen-language"
                  name="language"
                  className="w-full lg:w-56"
                  options={langOptions}
                  value={language}
                  onValueChange={setLanguage}
                  searchPlaceholder={t("classContent.author.languageSearch")}
                  emptyText={t("classContent.author.languageEmpty")}
                />
              </div>

              {templateList.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("classContent.author.structureLabel")}
                  </p>
                  <Select value={genTemplateId} onValueChange={setGenTemplateId}>
                    <SelectTrigger className="w-full lg:w-72">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("classContent.author.structureNone")}</SelectItem>
                      {templateList.map((tpl) => (
                        <SelectItem key={tpl.id} value={tpl.id}>
                          {tpl.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {isBooking && continuationCandidates.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("classContent.author.continueFromLabel")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("classContent.author.continueFromHint")}
                  </p>
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                    {continuationCandidates.map((c) => (
                      <label
                        key={c.materialId}
                        className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={continueFromIds.has(c.materialId)}
                          onChange={() => toggleContinueFrom(c.materialId)}
                        />
                        <span className="min-w-0">
                          <span className="block font-medium">
                            {c.label?.trim() ||
                              new Date(c.scheduledStart).toLocaleDateString(locale, {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                              })}
                          </span>
                          {c.preview && (
                            <span className="line-clamp-1 block text-xs text-muted-foreground">
                              {c.preview}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Level + focus tags moved into the save form (they're saved
                metadata first, generation seeds second) — the hidden
                levelId/focusTagId inputs above still post them here. */}
              <div className="flex gap-2">
                <Input
                  id="content-topic"
                  name="topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder={t("classContent.author.topicPlaceholder")}
                />
                <Button type="submit" variant="secondary" disabled={generating || !isPro}>
                  {generating
                    ? t("classContent.author.generating")
                    : t("classContent.author.generate")}
                </Button>
              </div>
              {isPro ? (
                <p className="text-xs text-muted-foreground">{t("classContent.author.aiHelp")}</p>
              ) : (
                <ProLockNote message={t("classContent.author.proRequired")} />
              )}
              {genState?.error && <p className="text-sm text-destructive">{genState.error}</p>}
            </form>
          </Collapsible>
        )}

        <form
          id={formId}
          ref={saveFormRef}
          action={saveAction}
          onSubmit={validateMaterialSubmit}
          className="space-y-3"
        >
          {bookingId && <input type="hidden" name="bookingId" value={bookingId} />}
          {existing && <input type="hidden" name="materialId" value={existing.id} />}
          {!isBooking && <input type="hidden" name="levelId" value={levelId} />}
          {!isBooking && <input type="hidden" name="visibility" value={visibility} />}
          {!isBooking && <input type="hidden" name="focusTagIdsPresent" value="1" />}
          {!isBooking &&
            [...focusTagIds].map((id) => (
              <input key={id} type="hidden" name="focusTagId" value={id} />
            ))}
          <input type="hidden" name="source" value={source} />
          {/* Timing only governs a body-less attachment on a class; a body is
                always visible once the class is confirmed. */}
          {isBooking && (
            <input
              type="hidden"
              name="sendTiming"
              value={sendTiming === "always" ? "" : sendTiming}
            />
          )}

          <div className="space-y-1">
            <Label htmlFor="content-label">{t("web.materials.nameOptional")}</Label>
            <Input
              id="content-label"
              name="label"
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("web.materials.labelPlaceholder")}
            />
          </div>
          {!isBooking && (
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="content-level">{t("web.materials.level")}</Label>
                <Select
                  value={levelId}
                  onValueChange={(v) => {
                    setLevelId(v);
                    clearError("level");
                  }}
                >
                  <SelectTrigger
                    id="content-level"
                    aria-invalid={Boolean(errors.level) || undefined}
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
                <FieldError id="content-level-error" message={errors.level} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="content-visibility">{t("web.materials.whoSeesIt")}</Label>
                <Select value={visibility} onValueChange={setVisibility}>
                  <SelectTrigger id="content-visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="at_or_below">
                      {t("web.materials.visibilityAtOrBelow")}
                    </SelectItem>
                    <SelectItem value="exact">{t("web.materials.visibilityExact")}</SelectItem>
                    <SelectItem value="all">{t("web.materials.visibilityAll")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Focus tags live in the SAVE form (they're saved metadata; the
              generate form posts them via its hidden inputs) — mobile parity
              with its top-level tagsSection. */}
          {focusGroups.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {isBooking ? t("classContent.author.focusLabel") : t("libManage.tags")}
              </p>
              <FocusTagSelect
                groups={focusGroups}
                selected={focusTagIds}
                onToggle={toggleFocusTag}
              />
            </div>
          )}

          {aiEnabled && body.trim() ? (
            // Read-only rendered body + "Edit with AI" (D-73), collapsed behind
            // a disclosure so Save is reachable without scrolling past a long
            // body. The body posts via the hidden field kept OUTSIDE the
            // collapsible so collapsing never drops it from the save form.
            <>
              <input type="hidden" name="body" value={body} />
              <Collapsible
                defaultOpen={contentDefaultOpen}
                title={t("web.dashboard.classes.classContent.contentMarkdown")}
                headerRight={copyButton}
              >
                {bodyEditor}
                {editWithAi}
              </Collapsible>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <Label htmlFor="content-body">
                  {t("web.dashboard.classes.classContent.contentMarkdown")}
                </Label>
                {copyButton}
              </div>

              {aiEnabled ? (
                // Empty body → the generate control above is the entry point.
                <div className="min-h-32 rounded-md border px-3 py-2">
                  <p className="text-sm text-muted-foreground">
                    {t("classContent.author.previewEmpty")}
                  </p>
                </div>
              ) : (
                // No AI configured — manual authoring is the only option, so the
                // raw-Markdown textarea stays as a graceful fallback.
                <>
                  <Textarea
                    id="content-body"
                    name="body"
                    value={body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      setSource("manual");
                    }}
                    rows={12}
                    className="font-mono text-sm"
                    placeholder={t("classContent.author.placeholder")}
                  />
                  <p
                    className={
                      "text-right text-xs " +
                      (overLimit ? "text-destructive" : "text-muted-foreground")
                    }
                    aria-live="polite"
                  >
                    {classContentLength(body).toLocaleString()} /{" "}
                    {CLASS_CONTENT_MAX_CHARS.toLocaleString()}
                  </p>
                </>
              )}
            </>
          )}

          {/* File + link attach onto the same material. Collapsed behind a
              disclosure (hidden, not unmounted, so the fields keep posting);
              controlled so a linkUrl/content validation error forces it open
              rather than hiding inside a closed section. */}
          <Collapsible
            title={t("materials.attachmentsSection")}
            open={attachOpen}
            onOpenChange={setAttachOpen}
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="content-file">{t("web.materials.file")}</Label>
                <input
                  id="content-file"
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
                <Label htmlFor="content-link">{t("materials.link")}</Label>
                <Input
                  id="content-link"
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
                  aria-describedby={errors.linkUrl ? "content-link-error" : undefined}
                />
                <FieldError id="content-link-error" message={errors.linkUrl} />
              </div>
            </div>
          </Collapsible>

          {/* When there's no body, a class attachment can still be scheduled. */}
          {isBooking && !body.trim() && (
            <div className="space-y-1 lg:w-56">
              <Label htmlFor="content-timing">{t("materials.timing")}</Label>
              <Select value={sendTiming} onValueChange={setSendTiming}>
                <SelectTrigger id="content-timing">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">{t("materials.timing.always")}</SelectItem>
                  <SelectItem value="confirmation">{t("materials.timing.confirmation")}</SelectItem>
                  <SelectItem value="t_5d">{t("materials.timing.t_5d")}</SelectItem>
                  <SelectItem value="t_24h">{t("materials.timing.t_24h")}</SelectItem>
                  <SelectItem value="t_1h">{t("materials.timing.t_1h")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Status, errors and Save all live in the pinned action bar below
              — the form itself ends with its fields. */}
        </form>

        {/* Podcast: turn a SAVED material's body into audio. Shown once the
              material exists (it needs an id to attach async audio to); before
              the first save, a hint to save first. Hidden entirely when podcast
              generation isn't configured. */}
        {podcastEnabled && existing && (
          // Collapsed by default, but `hidden`-based (never unmounted) — the
          // podcast section polls generation status on an interval, and
          // unmounting it mid-poll would silently drop an in-flight job.
          <Collapsible title={t("classContent.podcast.title")} defaultOpen={false}>
            <MaterialPodcastSection
              materialId={existing.id}
              enabled={podcastEnabled}
              initial={existing.podcast}
            />
          </Collapsible>
        )}
        {podcastEnabled && !existing && body.trim() && (
          <div className="flex items-center gap-1.5 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Mic className="size-4" aria-hidden />
            {t("classContent.podcast.saveFirst")}
          </div>
        )}

        {isBooking && levels.length > 0 && body.trim() && (
          <Collapsible title={t("classContent.author.saveToLibrary")} defaultOpen={false}>
            <form
              action={libAction}
              onSubmit={handleLibSubmit}
              className="space-y-2 rounded-md border bg-muted/40 p-3"
            >
              <input type="hidden" name="body" value={body} />
              <input type="hidden" name="source" value={source} />
              <input type="hidden" name="levelId" value={libLevel} />
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={libLevel}
                  onValueChange={(v) => {
                    setLibLevel(v);
                    setLibLevelError(undefined);
                  }}
                >
                  <SelectTrigger
                    className="w-40"
                    aria-invalid={Boolean(libLevelError) || undefined}
                  >
                    <SelectValue placeholder={t("classContent.author.pickLevel")} />
                  </SelectTrigger>
                  <SelectContent>
                    {levels.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="submit" variant="secondary" disabled={savingToLib}>
                  {savingToLib
                    ? t("classContent.author.savingToLibrary")
                    : t("classContent.author.saveToLibrary")}
                </Button>
              </div>
              <FieldError id="lib-level-error" message={libLevelError} />
              <p className="text-xs text-muted-foreground">
                {t("classContent.author.saveToLibraryHelp")}
              </p>
              {libState?.error && <p className="text-sm text-destructive">{libState.error}</p>}
              {libState?.ok && <p className="text-sm text-success">{libState.ok}</p>}
            </form>
          </Collapsible>
        )}

        {body.trim() && (
          <Collapsible title={t("classContent.author.saveAsTemplate")} defaultOpen={false}>
            <form
              action={tplAction}
              onSubmit={handleTplSubmit}
              className="space-y-2 rounded-md border bg-muted/40 p-3"
            >
              <input type="hidden" name="body" value={body} />
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="template-label"
                  name="label"
                  aria-label={t("classContent.author.saveAsTemplate")}
                  value={templateLabel}
                  onChange={(e) => {
                    setTemplateLabel(e.target.value);
                    setTemplateLabelError(undefined);
                  }}
                  placeholder={t("classContent.author.templateNamePlaceholder")}
                  className="w-56"
                  invalid={Boolean(templateLabelError)}
                  aria-describedby={templateLabelError ? "template-label-error" : undefined}
                />
                <Button type="submit" variant="secondary" disabled={savingTemplate}>
                  {savingTemplate
                    ? t("classContent.author.saving")
                    : t("classContent.author.saveAsTemplate")}
                </Button>
              </div>
              <FieldError id="template-label-error" message={templateLabelError} />
              {tplState?.error && <p className="text-sm text-destructive">{tplState.error}</p>}
            </form>
          </Collapsible>
        )}

        {existing && revisionList.length > 0 && (
          <Collapsible title={t("classContent.author.versionHistory")} defaultOpen={false}>
            <div className="space-y-2 rounded-md border bg-muted/40 p-3">
              <ul className="space-y-1.5">
                {revisionList.slice(0, 10).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {/* Which kind of change this revision undoes — without it,
                          a teacher scanning several similarly-timed rows for
                          "the one right before the AI messed it up" has only a
                          60-char text snippet to go on. */}
                      <span
                        className={
                          "mr-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 align-middle text-sm font-medium " +
                          (r.source === "ai"
                            ? "bg-clay-bg text-clay"
                            : "bg-muted text-muted-foreground")
                        }
                      >
                        {t(
                          r.source === "ai"
                            ? "classContent.author.revisionSourceAi"
                            : "classContent.author.revisionSourceManual",
                        )}
                      </span>
                      {new Date(r.createdAt).toLocaleString()}
                      {" — "}
                      {r.body.replace(/\s+/g, " ").trim().slice(0, 60) ||
                        t("web.dashboard.classes.classContent.emptyRevision")}
                    </span>
                    <form action={restoreAction}>
                      {bookingId && <input type="hidden" name="bookingId" value={bookingId} />}
                      <input type="hidden" name="materialId" value={existing.id} />
                      <input type="hidden" name="revisionId" value={r.id} />
                      <Button type="submit" variant="ghost" size="sm" disabled={restoring}>
                        {t("classContent.author.restore")}
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
              {restoreState?.error && (
                <p className="text-sm text-destructive">{restoreState.error}</p>
              )}
            </div>
          </Collapsible>
        )}
      </div>

      {/* Pinned action bar — Save (submitting the form above via its `form=`
          association; the browser dispatches submit on the form owner
          wherever the submitter lives), Cancel when the host provides one,
          and the ONE status line (materialSaveStatus: dirty beats a stale
          "Saved"). Sticky keeps its flow space, so no container padding is
          needed; z-30 sits under the app nav (z-40) and Radix portals (z-50). */}
      <div
        role="group"
        aria-label={t("classContent.author.actionsLabel")}
        className="sticky bottom-0 z-30 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-background/95 py-3 pb-safe-bottom backdrop-blur supports-[backdrop-filter]:bg-background/80"
      >
        <div className="min-w-0 flex-1 space-y-1">
          {saveStatus === "saving" ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t("classContent.author.saving")}
            </p>
          ) : saveStatus === "dirty" ? (
            <p className="text-sm text-warning" aria-live="polite">
              {t("classContent.author.unsavedChanges")}
            </p>
          ) : (
            <FormStatus state={saveState} savedMessage={t("classContent.author.savedShort")} />
          )}
          {saveStatus === "dirty" && saveState?.error && (
            <p className="text-sm text-destructive">{saveState.error}</p>
          )}
          <FieldError id="content-content-error" message={errors.content} />
          {(errors.level || errors.linkUrl) && (
            <p className="text-sm text-destructive" aria-live="polite">
              {t("classContent.author.fixErrors")}
            </p>
          )}
          {overLimit && (
            // The submit handler silently blocks an over-limit save — without
            // this line the Save button just looks dead.
            <p className="text-xs text-destructive" aria-live="polite">
              {t("material.editor.overLimit", {
                max: CLASS_CONTENT_MAX_CHARS.toLocaleString(),
                count: classContentLength(body).toLocaleString(),
              })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          )}
          <Button type="submit" form={formId} disabled={saving}>
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
