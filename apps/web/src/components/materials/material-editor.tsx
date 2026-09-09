"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { AiChangeChip } from "@/components/materials/ai-change-chip";
import { ChevronDown, ChevronUp, Copy, Plus, Sparkles, Trash2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionBlockEditor } from "@/components/materials/block-editor";
import { IconButton } from "@/components/materials/icon-button";
import { useT } from "@/components/locale-provider";
import {
  adoptBody,
  applySectionAction,
  editorSections,
  emptySectionEditorState,
  hasSection,
  undoSectionAction,
  type EditorSection,
  type SectionAction,
  type SectionActionKind,
  type SectionEditorState,
} from "@spiralclass/shared";
import { refineMaterialDraftAction, type RefineMaterialState } from "@/app/actions/library";

// The structural section editor (Layer 2 of
// the material-editing design). It replaces the read-only body
// preview inside MaterialForm: the same parsed document, cut into cards at the
// shallowest heading level that has siblings, each card rendered by the very
// renderer the student sees (MaterialDocument) so "edit mode" and "the material"
// are visually the same thing.
//
// Every structural change runs through the shared section-editor state core in
// @spiralclass/shared (packages/shared/src/material-doc/editor.ts, which holds
// all the state logic and is unit-tested there — promoted from this
// component's own apps/web/src/lib/materials/section-editor.ts so the mobile
// section editor drives the identical behaviour) and comes back as Markdown —
// the stored wire format never changes, so the PDF, podcast, homework
// auto-draft and refine prompt pipelines keep working untouched.
//
// Undo is deliberately local and in-session only: the MaterialRevision snapshot
// taken on save is the real backstop, this just makes a mis-click cheap.

export type MaterialEditorProps = {
  /** Current Markdown body — MaterialForm owns it (it posts with the save form). */
  body: string;
  /** `aiEdited` marks a change the model produced, so the caller can flip the
   * material's source to "ai" exactly as a whole-document refine does. */
  onChange: (body: string, opts?: { aiEdited?: boolean }) => void;
  /** Whether per-section "Edit with AI" is offered (platform creds + Pro plan). */
  canRefine?: boolean;
  /** Registry code the material is written in — forwarded to the refine action. */
  language?: string;
};

export function MaterialEditor({
  body,
  onChange,
  canRefine = false,
  language,
}: MaterialEditorProps) {
  const t = useT();
  const [state, setState] = useState<SectionEditorState>(() => emptySectionEditorState(body));

  // The body prop is the source of truth. When it changes underneath us — a
  // whole-document refine, a restored revision, a template — adopt it and drop
  // an undo stack that now describes a different document. (Changes we emit
  // ourselves arrive back identical, so they don't trip this.)
  if (state.body !== body) setState((prev) => adoptBody(prev, body));

  const sections = useMemo(() => editorSections(state), [state]);

  /** Returns false only when a refine's target card no longer exists — the
   * result was DISCARDED rather than spliced at a guessed position, and the
   * caller should tell the teacher. Every synchronous action returns true. */
  function dispatch(action: SectionAction): boolean {
    if (action.kind === "refine" && !hasSection(state, action.id)) return false;
    const next = applySectionAction(state, action);
    if (next === state) return true;
    setState(next);
    onChange(next.body, { aiEdited: action.kind === "refine" });
    return true;
  }

  function undo() {
    const next = undoSectionAction(state);
    if (next === state) return;
    setState(next);
    onChange(next.body);
  }

  const lastChange: SectionActionKind | undefined = state.history[0]?.kind;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("material.editor.hint")}</p>
        {lastChange === "refine" ? (
          // An AI change gets its own, more prominent affordance than the
          // generic diff bar below — a teacher who just watched the AI touch
          // a section should never have to notice a quiet text change to find
          // her way back to it.
          <AiChangeChip>
            {t("material.editor.aiSectionChanged")}
            <Button type="button" variant="ghost" size="sm" onClick={undo}>
              <Undo2 className="mr-1 size-4" aria-hidden />
              {t("material.editor.undoAiChange")}
            </Button>
          </AiChangeChip>
        ) : (
          lastChange && (
            <div className="flex items-center gap-1.5" aria-live="polite">
              <span className="text-xs text-muted-foreground">{t(CHANGE_LABEL[lastChange])}</span>
              <Button type="button" variant="ghost" size="sm" onClick={undo}>
                <Undo2 className="mr-1 size-4" aria-hidden />
                {t("material.editor.undo")}
              </Button>
            </div>
          )
        )}
      </div>

      <div className="space-y-1">
        <AddSectionRow onAdd={() => dispatch(insertAt(0, t("material.editor.newSectionTitle")))} />
        {sections.map((section) => (
          // Keyed by the STABLE section id, not the index: per-card UI state
          // (an open refine box, a half-typed instruction, an in-flight
          // request) must follow its section when cards shift position.
          <div key={section.id} className="space-y-1">
            <SectionCard
              section={section}
              isFirst={section.index === 0}
              isLast={section.index === sections.length - 1}
              isOnly={sections.length === 1}
              canRefine={canRefine}
              language={language}
              onAction={dispatch}
            />
            <AddSectionRow
              onAdd={() =>
                dispatch(insertAt(section.index + 1, t("material.editor.newSectionTitle")))
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const CHANGE_LABEL = {
  move: "material.editor.changed.move",
  delete: "material.editor.changed.delete",
  duplicate: "material.editor.changed.duplicate",
  insert: "material.editor.changed.insert",
  refine: "material.editor.changed.refine",
  editBlocks: "material.editor.changed.editBlocks",
} as const;

function insertAt(index: number, title: string): SectionAction {
  return { kind: "insert", index, title };
}

/** The hairline "+" between two cards. Low-contrast until hovered so a long
 * document still reads as a document, not as a toolbar sandwich. */
function AddSectionRow({ onAdd }: { onAdd: () => void }) {
  const t = useT();
  return (
    <div className="group flex items-center gap-2 py-0.5">
      <span className="h-px flex-1 bg-border opacity-40 transition-opacity group-hover:opacity-100" />
      <button
        type="button"
        onClick={onAdd}
        aria-label={t("material.editor.addSectionHere")}
        className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground opacity-60 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
      >
        <Plus className="size-3.5" aria-hidden />
        {t("material.editor.addSection")}
      </button>
      <span className="h-px flex-1 bg-border opacity-40 transition-opacity group-hover:opacity-100" />
    </div>
  );
}

function SectionCard({
  section,
  isFirst,
  isLast,
  isOnly,
  canRefine,
  language,
  onAction,
}: {
  section: EditorSection;
  isFirst: boolean;
  isLast: boolean;
  isOnly: boolean;
  canRefine: boolean;
  language?: string;
  onAction: (action: SectionAction) => boolean;
}) {
  const t = useT();
  const title =
    section.title ??
    (section.level === null
      ? t("material.editor.leadSection")
      : t("material.editor.untitledSection"));

  return (
    <section className="rounded-md border bg-background" aria-label={title}>
      <div className="flex items-center gap-1 rounded-t-md border-b bg-muted/40 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        <IconButton
          label={t("material.editor.moveUp")}
          disabled={isFirst}
          onClick={() => onAction({ kind: "move", from: section.index, to: section.index - 1 })}
        >
          <ChevronUp className="size-4" aria-hidden />
        </IconButton>
        <IconButton
          label={t("material.editor.moveDown")}
          disabled={isLast}
          onClick={() => onAction({ kind: "move", from: section.index, to: section.index + 1 })}
        >
          <ChevronDown className="size-4" aria-hidden />
        </IconButton>
        <IconButton
          label={t("material.editor.duplicate")}
          onClick={() => onAction({ kind: "duplicate", index: section.index })}
        >
          <Copy className="size-4" aria-hidden />
        </IconButton>
        <IconButton
          label={t("material.editor.delete")}
          destructive
          // Deleting the only card would empty the body and unmount the whole
          // editor, undo stack included — the shared state core refuses it too.
          disabled={isOnly}
          onClick={() => onAction({ kind: "delete", index: section.index })}
        >
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>

      <div className="px-3 py-2">
        <SectionBlockEditor section={section} onAction={onAction} />
      </div>

      {canRefine && <SectionRefine section={section} language={language} onAction={onAction} />}
    </section>
  );
}

/** Per-section "Edit with AI": the SAME refine action the whole-document box
 * uses, given only this section's Markdown as the body. The model therefore
 * cannot over-rewrite the parts the teacher didn't ask about, and a section
 * refine costs the same one generation a whole-document one does. Zero backend
 * change — the action is scope-agnostic `{ body, instruction, language }`. */
function SectionRefine({
  section,
  language,
  onAction,
}: {
  section: EditorSection;
  language?: string;
  onAction: (action: SectionAction) => boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  // The dispatch found the target card gone and discarded the result (only
  // reachable when identity was regenerated under the card — normally deleting
  // the card unmounts this component and the pending request with it).
  const [dropped, setDropped] = useState(false);
  const [refineState, refineAction, refining] = useActionState<RefineMaterialState, FormData>(
    refineMaterialDraftAction,
    undefined,
  );

  // The target card's STABLE id, captured at dispatch: it survives moves,
  // renumbering and unrelated edits while the model round trip is in flight,
  // so the splice lands on the card the teacher actually asked about — or is
  // discarded if that card is gone, never spliced at a guessed position.
  const sentRef = useRef<{ id: string } | null>(null);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  useEffect(() => {
    const sent = sentRef.current;
    if (!refineState?.body || !sent) return;
    sentRef.current = null;
    const applied = onActionRef.current({
      kind: "refine",
      id: sent.id,
      markdown: refineState.body,
    });
    if (applied) {
      setInstruction("");
      setOpen(false);
    } else {
      setDropped(true);
    }
    // Keyed on the state OBJECT, not its body: useActionState hands back a new
    // object per dispatch, so two refines that happen to return identical
    // Markdown still each resolve their own pending request.
  }, [refineState]);

  function trigger() {
    if (!instruction.trim() || refining) return;
    setDropped(false);
    sentRef.current = { id: section.id };
    const fd = new FormData();
    fd.set("body", section.markdown);
    fd.set("instruction", instruction);
    if (language) fd.set("language", language);
    refineAction(fd);
  }

  if (!open) {
    return (
      <div className="border-t px-2 py-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          <Sparkles className="mr-1 size-4" aria-hidden />
          {t("material.editor.refineSection")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 border-t px-3 py-2">
      <p className="text-xs text-muted-foreground">{t("material.editor.refineSectionHint")}</p>
      <div className="flex gap-2">
        <Input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              trigger();
            }
          }}
          placeholder={t("classContent.author.refineInstructionPlaceholder")}
          aria-label={t("material.editor.refineSection")}
          disabled={refining}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={trigger}
          disabled={refining || !instruction.trim()}
        >
          {!refining && <Sparkles className="mr-1 size-4" aria-hidden />}
          {refining ? t("classContent.author.refining") : t("classContent.author.editWithAi")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={refining}>
          {t("common.cancel")}
        </Button>
      </div>
      {refineState?.error && <p className="text-sm text-destructive">{refineState.error}</p>}
      {dropped && (
        <p className="text-sm text-destructive">{t("material.editor.refineSectionGone")}</p>
      )}
    </div>
  );
}
