import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Download,
  Eye,
  FileText,
  KeyRound,
  Layers,
  Link as LinkIcon,
  Paperclip,
  Sparkles,
} from "lucide-react";
import { fileExtensionOf, materialKindOf, type MaterialKind } from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { ClassContentMarkdown } from "@/components/class-content/class-content-markdown";
import type { FocusGroup } from "@/components/focus-tags/focus-tag-select";
import { setLibraryMaterialArchivedAction } from "@/app/actions/library";
import type { MaterialRevisionRow } from "@/lib/materials/revisions";
import { getT } from "@/lib/i18n";
import { LibraryEditForm } from "./edit-form";
import { LibraryContentEditForm } from "./content-edit-form";
import { DeleteMaterialButton } from "./delete-material-button";

// One row of the teacher's material library.
//
// Extracted from page.tsx, which had grown to a 636-line file whose middle
// three hundred lines were this. Nothing about the data flow changed: the page
// still resolves the level/visibility labels, mints the signed URL and loads
// the revisions, because those are per-page concerns (one query, one presign
// budget) and a row that fetched for itself would turn a page into N of each.
//
// What DID change is what a row shows and how loud each of its actions is —
// see the notes at each part below.

type LevelOption = { id: string; label: string };
type Template = { id: string; label: string; body: string };

export type MaterialCardRow = {
  id: string;
  label: string | null;
  unit: string | null;
  body: string | null;
  storagePath: string | null;
  linkUrl: string | null;
  levelId: string | null;
  visibility: string;
  contentSource: string | null;
  createdAt: Date;
  focusTags: { focusTag: { id: string; label: string } }[];
  viewUrl: string | null;
  hasAnswerKey: boolean;
  revisions: MaterialRevisionRow[];
};

// The kind is a categorical axis, so it gets a categorical encoding — icon AND
// tint AND a text label, never colour alone. The three grounds are the palette's
// own gentle tints, verified against their foreground token in both themes.
const KIND_ICON: Record<MaterialKind, typeof FileText> = {
  written: FileText,
  file: Paperclip,
  link: LinkIcon,
};
const KIND_TINT: Record<MaterialKind, string> = {
  written: "bg-info-bg text-info",
  file: "bg-clay-bg text-clay",
  link: "bg-sage-bg text-sage",
};
const KIND_LABEL_KEY = {
  written: "web.materials.kindWritten",
  file: "web.materials.kindFile",
  link: "web.materials.kindLink",
} as const;

export async function MaterialCard({
  material: m,
  levelLabel,
  visibilityLabel,
  view,
  levels,
  focusGroups,
  templates,
  aiEnabled,
  isPro,
  podcastEnabled,
  dateLabel,
}: {
  material: MaterialCardRow;
  levelLabel: string | null;
  visibilityLabel: string;
  view: "active" | "archived";
  levels: LevelOption[];
  focusGroups: FocusGroup[];
  templates: Template[];
  aiEnabled: boolean;
  isPro: boolean;
  podcastEnabled: boolean;
  /** Preformatted in the teacher's own zone and locale by the page. */
  dateLabel: string;
}) {
  const t = await getT();
  const kind = materialKindOf(m);
  const KindIcon = KIND_ICON[kind];
  const kindLabel = t(KIND_LABEL_KEY[kind]);
  // The extension is the one thing about a file a teacher recognises from
  // across the room, and the title often hides it (a label overrides the
  // filename). Only shown when the storage key actually carries one.
  const extension = kind === "file" ? fileExtensionOf(m.storagePath ?? "") : null;
  const title =
    m.label ??
    (kind === "written"
      ? t("web.materials.classContent")
      : kind === "file"
        ? t("web.materials.file")
        : m.linkUrl
          ? t("web.materials.link")
          : t("web.materials.materialFallback"));

  return (
    // No overflow-hidden on the card: it would make this <li> the nearest
    // scrollport, and a scrollport that never scrolls means the edit form's
    // sticky Save bar could never stick. The footer div carries its own
    // rounded-b-lg instead.
    <li className="bg-card hover:border-foreground/20 rounded-lg border shadow-xs transition-colors">
      <div className="flex gap-3 p-4">
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-md ${KIND_TINT[kind]}`}
        >
          <KindIcon className="size-4" aria-hidden />
          {/* Announced before the title so a screen reader reaches "Written,
              Past simple worksheet" rather than a title whose kind is carried
              only by an icon it will not read. */}
          <span className="sr-only">{kindLabel}</span>
        </span>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            {/* h3 under the list's own sr-only h2 — see page.tsx. A row was a
                bare <span>/<a> before, so a screen reader had no way to move
                between materials except by walking every link on the page. */}
            <h3 className="min-w-0 text-sm font-semibold">
              {m.viewUrl ? (
                <a
                  href={m.viewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-primary focus-visible:ring-ring rounded-sm underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current focus-visible:ring-3 focus-visible:outline-hidden"
                >
                  {title}
                  <span className="sr-only"> ({t("web.materials.opensInNewTab")})</span>
                </a>
              ) : (
                title
              )}
            </h3>
            {m.contentSource === "ai" && (
              <Badge variant="secondary" title={t("web.materials.aiAuthoredTitle")}>
                <Sparkles className="size-3" aria-hidden />
                {t("web.materials.aiAuthored")}
              </Badge>
            )}
          </div>

          {/* Provenance, one quiet line: what unit it belongs to and when it
              landed. "Added" is what makes the Newest/Oldest sort legible —
              the list offered that order with the value it ordered by nowhere
              on screen. */}
          <p className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
            {m.unit && <span>{t("web.materials.unitLabel", { unit: m.unit })}</span>}
            {m.unit && (
              // An expression, not the `&middot;` entity: the i18n scanner reads
              // raw JSX text and an HTML entity name is letters to it.
              <span aria-hidden className="opacity-50">
                {"\u00B7"}
              </span>
            )}
            <span>{t("web.materials.addedOn", { date: dateLabel })}</span>
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="info" className="gap-1">
              <Layers className="size-3" aria-hidden />
              {levelLabel ?? "—"}
            </Badge>
            <Badge variant="secondary" className="gap-1">
              <Eye className="size-3" aria-hidden />
              {visibilityLabel}
            </Badge>
            {/* Lower case, deliberately: D-140 withdrew all-caps micro-labels
                because capitals remove the word-shape a dyslexic reader leans
                on, and "pdf" is the extension as it is actually written. */}
            {extension && (
              <Badge variant="outline" className="text-muted-foreground font-normal">
                {extension}
              </Badge>
            )}
            {m.focusTags.map(({ focusTag }) => (
              <Badge
                key={focusTag.id}
                variant="outline"
                className="text-muted-foreground font-normal"
              >
                {focusTag.label}
              </Badge>
            ))}
          </div>

          {view === "active" && m.body && (
            <details className="group [&_summary::-webkit-details-marker]:hidden">
              <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs transition-colors focus-visible:ring-3 focus-visible:outline-hidden">
                <ChevronRight
                  className="size-3.5 transition-transform group-open:rotate-90"
                  aria-hidden
                />
                <span className="group-open:hidden">{t("web.materials.previewContent")}</span>
                <span className="hidden group-open:inline">{t("web.materials.hidePreview")}</span>
              </summary>
              <div className="mt-2 border-t pt-2">
                <ClassContentMarkdown body={m.body} />
              </div>
            </details>
          )}
        </div>
      </div>

      {/* The footer used to be five identically-weighted outline buttons, so
          "Delete" — which is permanent and frees the storage object — read
          exactly as loudly as "Download". Two groups now: what she does WITH
          the material on the left, what she does TO it on the right, and only
          the two everyday actions keep a border. */}
      <div className="bg-muted/20 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-b-lg border-t px-3 py-2">
        {view === "active" ? (
          <>
            {m.body && (
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <a href={`/api/materials/${m.id}/pdf`} aria-label={t("web.materials.downloadPdf")}>
                  <Download className="size-4" aria-hidden />
                  {t("web.materials.download")}
                </a>
              </Button>
            )}
            {/* The plain Download above is the STUDENT copy — the one she hands
                out — so the answer-key copy is a second, explicitly-labelled
                action rather than a mode toggle on the first. Offered only when
                the material actually has `[!answer]` blocks: otherwise the two
                files are identical and a second button would just be a trap. */}
            {m.hasAnswerKey && (
              <Button asChild variant="ghost" size="sm" className="gap-1.5">
                <a
                  href={`/api/materials/${m.id}/pdf?answers=1`}
                  aria-label={t("web.materials.downloadPdfAnswerKey")}
                >
                  <KeyRound className="size-4" aria-hidden />
                  {t("web.materials.downloadAnswerKey")}
                </a>
              </Button>
            )}
            {m.body ? (
              <LibraryContentEditForm
                material={{
                  id: m.id,
                  body: m.body,
                  source: (m.contentSource as "manual" | "ai") ?? "manual",
                  label: m.label,
                  levelId: m.levelId!,
                  visibility: m.visibility,
                  focusTagIds: m.focusTags.map(({ focusTag }) => focusTag.id),
                  linkUrl: m.linkUrl,
                  storagePath: m.storagePath,
                }}
                levels={levels}
                focusGroups={focusGroups}
                templates={templates}
                revisions={m.revisions}
                aiEnabled={aiEnabled}
                isPro={isPro}
                podcastEnabled={podcastEnabled}
              />
            ) : (
              <LibraryEditForm
                material={{
                  id: m.id,
                  levelId: m.levelId!,
                  visibility: m.visibility,
                  label: m.label,
                  unit: m.unit,
                  focusTagIds: m.focusTags.map(({ focusTag }) => focusTag.id),
                }}
                levels={levels}
                focusGroups={focusGroups}
              />
            )}
            <form action={setLibraryMaterialArchivedAction} className="ml-auto">
              <input type="hidden" name="materialId" value={m.id} />
              <input type="hidden" name="archived" value="true" />
              <SubmitButton variant="ghost" size="sm" className="gap-1.5">
                <Archive className="size-4" aria-hidden />
                {t("web.materials.archive")}
              </SubmitButton>
            </form>
          </>
        ) : (
          <form action={setLibraryMaterialArchivedAction} className="ml-auto">
            <input type="hidden" name="materialId" value={m.id} />
            <input type="hidden" name="archived" value="false" />
            <SubmitButton variant="outline" size="sm" className="gap-1.5">
              <ArchiveRestore className="size-4" aria-hidden />
              {t("web.materials.restore")}
            </SubmitButton>
          </form>
        )}
        <DeleteMaterialButton materialId={m.id} name={title} />
      </div>
    </li>
  );
}
