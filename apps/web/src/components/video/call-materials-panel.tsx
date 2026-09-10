"use client";

import { Heading } from "@/components/ui/heading";
import { useEffect, useState } from "react";
import { Files } from "lucide-react";
import { toast } from "sonner";
import type { CallMaterial } from "@spiralclass/shared";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import { ClassContentMarkdown } from "@/components/class-content/class-content-markdown";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CallLibraryBrowser } from "./call-library-browser";
import { CallMaterialPdf } from "./call-material-pdf";

// In-call material picker (web). A drop-in for the call control bar: the
// "Materials" button plus its own list popover. "This class" lists the
// materials already attached to the class and already authorized for whoever
// is on the call (teacher sees all, student sees released) — nothing is
// broadcast between participants; each side simply opens what it wants, and
// the teacher cues which one verbally.
//
// Teacher-only (canBrowseLibrary): a second "My library" tab lets her reach
// her ENTIRE reusable material library, not just what's attached to this
// class — reusing the same server-side query engine and JSON endpoints the
// mobile library screen already calls (see call-library-browser.tsx). This
// is gated by the caller (TeacherCallPage passes canBrowseLibrary; the student
// call page never does), matching how canRecord/canCaption already gate
// teacher-only controls in this same bar.
//
// Picking a material the viewer can render hands it up via onOpenInCall — the
// parent renders it in the main video area, REPLACING the other participant's
// video (see CallMaterialViewer), so both people focus on the material with the
// self-view and controls still in place. That is every `content` item and every
// `file` whose attachment is a PDF or an image (`fileKind`, resolved
// server-side). Anything else — a .docx, a .zip, an external link — still opens
// externally (a new tab, the call keeps running in this one) with a note that
// it leaves the call.
export function CallMaterialsPanel({
  materials,
  onOpenInCall,
  canBrowseLibrary = false,
  bookingId,
  hasRemote = false,
  onSendToRemote,
  onOpenChange,
}: {
  materials: CallMaterial[];
  onOpenInCall: (m: CallMaterial) => void;
  canBrowseLibrary?: boolean;
  // Present only on the teacher's call page — used both to gate the
  // open-choice sheet below (student picks stay a plain, direct open) and to
  // let "Assign this material to today's lesson" attach a LIBRARY item onto
  // THIS booking.
  bookingId?: string;
  // Whether the other participant is currently in the room — with nobody to
  // send to, "for student"/"for both" would be a dead-end offer, so the
  // choice sheet doesn't appear at all and a pick just opens locally (the
  // pre-existing behavior).
  hasRemote?: boolean;
  onSendToRemote?: (m: CallMaterial) => boolean;
  // Fires whenever the material list sheet opens/closes — lets the call
  // controls bar hold itself visible while this "menu" is open, instead of
  // auto-hiding out from under the user mid-pick.
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    onOpenChange?.(listOpen);
  }, [listOpen, onOpenChange]);
  const [tab, setTab] = useState<"class" | "library">(initialMaterialsTab(materials.length));
  // A material the viewer can render (rendersInCall), picked while someone
  // else is in the room: instead of opening immediately, ask who it's for
  // (teacher-only — canBrowseLibrary gates this whole sheet, so a student's
  // own "This class" picks stay a direct, unprompted open, unchanged from
  // before). A PDF or an image reaches this sheet now for the same reason a
  // content item always did: the receiver can be SHOWN it, in the call, rather
  // than having a browser tab pushed open over the lesson on her device.
  const [choice, setChoice] = useState<{ material: CallMaterial; fromLibrary: boolean } | null>(
    null,
  );
  const [assignToLesson, setAssignToLesson] = useState(true);

  // Nothing attached to this class AND no library to browse — no control at
  // all, same as the caption toggle only appearing when captioning is
  // available. A teacher with an empty class list but a browsable library
  // still gets the button (the whole point of this feature).
  if (!shouldShowMaterialsControl(materials.length, canBrowseLibrary)) return null;

  // Record that this material was opened during the class — the teacher-private
  // ledger behind "what did we use last time?" (lib/materials/record-use.ts).
  // Fires on EVERY open branch below, which is the whole point: before this,
  // only one of the four (content, student present, checkbox left ticked)
  // left any trace, so the materials she reached for mid-call were precisely
  // the ones nothing remembered. Distinct from "assign to lesson" below, which
  // additionally SHARES the material with the student and notifies her.
  //
  // Teacher-only (canBrowseLibrary gates this whole surface) and best-effort:
  // the material is already open either way, so a failed record must never
  // undo that. Dynamically imported for the same reason the attach action is —
  // the server action's module graph pulls server-only env validation that has
  // no business in this "use client" bundle, and would break this file's
  // pure-logic unit test.
  const recordUse = (m: CallMaterial, openedFor: "teacher" | "student" | "both") => {
    if (!canBrowseLibrary || !bookingId) return;
    const fd = new FormData();
    fd.set("bookingId", bookingId);
    fd.set("materialId", m.id);
    fd.set("openedFor", openedFor);
    void import("@/app/actions/class-material-use").then(({ recordClassMaterialUseAction }) =>
      recordClassMaterialUseAction(fd),
    );
  };

  const open = (m: CallMaterial, fromLibrary = false) => {
    if (!rendersInCall(m)) {
      // A file with no in-page renderer, or an external link — hand off to the
      // browser in a new tab. The call stays live in this tab. rel=noreferrer
      // matches how materials open everywhere else. Never routed through the
      // choice sheet: pushing an external tab open on the OTHER person's
      // device is a much more intrusive action than sharing the in-call
      // viewer, and isn't what this feature asked for — so it only ever opens
      // on her screen, which is what the "teacher" audience records.
      setListOpen(false);
      recordUse(m, "teacher");
      if (m.viewUrl) window.open(m.viewUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (canBrowseLibrary && hasRemote && onSendToRemote) {
      setListOpen(false);
      setAssignToLesson(fromLibrary);
      setChoice({ material: m, fromLibrary });
      // Recorded in resolveChoice instead, where the audience is known.
      return;
    }
    setListOpen(false);
    recordUse(m, "teacher");
    onOpenInCall(m);
  };

  const resolveChoice = (target: "me" | "student" | "both") => {
    if (!choice) return;
    const { material, fromLibrary } = choice;
    recordUse(material, target === "me" ? "teacher" : target === "student" ? "student" : "both");
    if (target !== "student") onOpenInCall(material);
    if (target !== "me" && onSendToRemote) {
      const sent = onSendToRemote(material);
      if (sent) toast.success(t("call.materialSentToStudent"));
    }
    if (fromLibrary && bookingId && assignToLesson) {
      const fd = new FormData();
      fd.set("bookingId", bookingId);
      fd.set("libraryMaterialId", material.id);
      fd.set("sendTiming", "confirmation");
      // Best-effort: the material is already open either way, so an assign
      // failure (a rare tenant/Pro-gate edge case) shouldn't undo the open.
      // Dynamically imported (rather than a static top-level import): this
      // server action's module graph pulls in server-only env validation
      // (Inngest/DB) that has no business loading into this "use client"
      // component's bundle just to be referenced — and it broke the
      // pure-logic unit test for this file, which has no server env
      // configured. A dynamic import only actually loads it when a teacher
      // checks "assign to lesson", which never happens in that test.
      void import("@/app/actions/booking-library-materials").then(
        ({ attachLibraryMaterialToBookingQuickAction }) =>
          attachLibraryMaterialToBookingQuickAction(fd),
      );
    }
    setChoice(null);
  };

  return (
    <>
      {/* Matches the round icon control buttons in the call bar (class-call.tsx):
          a tile + caption, "on" (list open) reads as a solid white tile. */}
      <button
        type="button"
        data-testid="call-materials-button"
        onClick={() => setListOpen((v) => !v)}
        aria-label={t("call.materials")}
        aria-pressed={listOpen}
        className="flex w-16 flex-col items-center gap-1.5"
      >
        <span
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-colors",
            listOpen
              ? "bg-overlay-4 text-scrim-3 hover:bg-overlay-4"
              : "bg-overlay-1 hover:bg-overlay-2 text-white backdrop-blur-md",
          )}
        >
          <Files className="h-5 w-5" aria-hidden />
        </span>
        <span className="text-on-dark-muted text-center text-sm leading-tight">
          {t("call.materials")}
        </span>
      </button>

      {/* Material list — a sheet over the video the teacher/student picks from. */}
      {listOpen && (
        <div className="z-over-overlay fixed inset-0 flex items-end justify-center lg:items-center">
          <button
            type="button"
            aria-label={t("call.materialsClose")}
            className="bg-scrim-2 absolute inset-0"
            onClick={() => setListOpen(false)}
          />
          <div
            data-testid="call-materials-sheet"
            className="max-h-over-stage bg-background text-foreground relative m-4 w-full max-w-md overflow-y-auto rounded-2xl p-4 shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <Heading level={4} as="h2">
                {t("call.materials")}
              </Heading>
              <button
                type="button"
                onClick={() => setListOpen(false)}
                className="text-muted-foreground hover:bg-muted rounded-md px-2 py-1 text-sm"
              >
                {t("call.materialsClose")}
              </button>
            </div>
            {canBrowseLibrary ? (
              <Tabs value={tab} onValueChange={(v) => setTab(v as "class" | "library")}>
                <TabsList className="mb-3 grid w-full grid-cols-2">
                  <TabsTrigger value="class" data-testid="call-materials-tab-class">
                    {t("call.materialsTabClass")}
                  </TabsTrigger>
                  <TabsTrigger value="library" data-testid="call-materials-tab-library">
                    {t("call.materialsTabLibrary")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="class" className="mt-0">
                  <MaterialsList materials={materials} onOpen={(m) => open(m, false)} t={t} />
                </TabsContent>
                <TabsContent value="library" className="mt-0">
                  <CallLibraryBrowser onSelect={(m) => open(m, true)} />
                </TabsContent>
              </Tabs>
            ) : (
              <MaterialsList materials={materials} onOpen={(m) => open(m, false)} t={t} />
            )}
          </div>
        </div>
      )}

      {/* Open-for choice — only ever reached from the teacher's library tab
          while a student is present (see `open` above). */}
      {choice && (
        <div className="z-over-everything fixed inset-0 flex items-end justify-center lg:items-center">
          <button
            type="button"
            aria-label={t("call.materialOpenChoiceCancel")}
            className="bg-scrim-2 absolute inset-0"
            onClick={() => setChoice(null)}
          />
          <div
            data-testid="call-material-open-choice"
            className="bg-background text-foreground relative m-4 w-full max-w-sm rounded-2xl p-4 shadow-2xl"
          >
            <h3 className="mb-3 text-sm font-semibold">{t("call.materialOpenChoiceTitle")}</h3>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                data-testid="call-material-open-me"
                onClick={() => resolveChoice("me")}
                className="border-border hover:bg-muted rounded-lg border px-3 py-2 text-left text-sm"
              >
                {t("call.materialOpenForMe")}
              </button>
              <button
                type="button"
                data-testid="call-material-open-student"
                onClick={() => resolveChoice("student")}
                className="border-border hover:bg-muted rounded-lg border px-3 py-2 text-left text-sm"
              >
                {t("call.materialOpenForStudent")}
              </button>
              <button
                type="button"
                data-testid="call-material-open-both"
                onClick={() => resolveChoice("both")}
                className="border-border hover:bg-muted rounded-lg border px-3 py-2 text-left text-sm"
              >
                {t("call.materialOpenForBoth")}
              </button>
            </div>
            {choice.fromLibrary && bookingId && (
              <label className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={assignToLesson}
                  onChange={(e) => setAssignToLesson(e.target.checked)}
                />
                {t("call.materialAssignToLesson")}
              </label>
            )}
            <button
              type="button"
              onClick={() => setChoice(null)}
              className="text-muted-foreground hover:bg-muted mt-3 w-full rounded-md px-2 py-1.5 text-center text-sm"
            >
              {t("call.materialOpenChoiceCancel")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function MaterialsList({
  materials,
  onOpen,
  t,
}: {
  materials: CallMaterial[];
  onOpen: (m: CallMaterial) => void;
  t: ReturnType<typeof useT>;
}) {
  if (materials.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("call.materialsNoneForClass")}</p>;
  }

  return (
    <ul className="space-y-2">
      {materials.map((m) => (
        <li key={m.id}>
          <button
            type="button"
            data-testid={`call-material-item-${m.id}`}
            onClick={() => onOpen(m)}
            className="border-border hover:bg-muted flex w-full flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left"
          >
            <span className="text-sm font-medium">{m.label ?? t(labelFallbackKey(m.kind))}</span>
            {!rendersInCall(m) && (
              <span className="text-muted-foreground text-xs">
                {t("call.materialOpensExternally")}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

// The content viewer, rendered IN the main video region (not a modal): an opaque
// panel that fills the area where the remote participant's video was, so the
// material takes their place while the self-view and controls stay put. Native
// Markdown, scrollable, with a close button back to the video.
export function CallMaterialViewer({
  material,
  onClose,
}: {
  material: CallMaterial;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div
      data-testid="call-material-viewer"
      className="bg-background text-foreground absolute inset-0 z-10 flex flex-col"
    >
      <div className="border-border flex items-center justify-between border-b px-5 py-3">
        <Heading level={4} as="h2" className="truncate">
          {material.label ?? t("call.materials")}
        </Heading>
        <button
          type="button"
          data-testid="call-material-viewer-close"
          onClick={onClose}
          className="hover:bg-muted shrink-0 rounded-md px-3 py-1.5 text-sm font-medium"
        >
          {t("call.materialsClose")}
        </button>
      </div>
      {/* Centered reading column rather than edge-to-edge text: on a wide
          screen a full-bleed line length is hard to read AND leaves no clear
          margin for the floating self-view corner tile (z-20, see
          stage-layout.ts) to sit over, so long lines visibly ran underneath
          it. The max-width leaves that margin free instead of relying on
          padding alone. Bottom padding still clears the self-view vertically.
          A PDF or an image gets the same column for the same reasons — the
          page is what has to clear the self-view, not just a line of text. */}
      <div className="flex-1 overflow-y-auto px-5 py-4 pb-40">
        <div className="mx-auto max-w-2xl">
          {material.kind === "file" && material.fileKind === "pdf" && material.viewUrl ? (
            <CallMaterialPdf url={material.viewUrl} />
          ) : material.kind === "file" && material.fileKind === "image" && material.viewUrl ? (
            /* Not next/image: the src is a signed URL on a per-teacher R2 host
               that no remotePattern covers, and routing a private object
               through the optimizer would cache it on our side for a URL that
               is meant to expire. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={material.viewUrl}
              alt={material.label ?? ""}
              data-testid="call-material-image"
              className="mx-auto h-auto w-full rounded-lg"
            />
          ) : (
            <ClassContentMarkdown body={material.body ?? ""} />
          )}
        </div>
      </div>
    </div>
  );
}

function labelFallbackKey(kind: CallMaterial["kind"]) {
  return kind === "file" ? "materials.fileAttachment" : "materials.linkAttachment";
}

// Pure decision helpers pulled out of the component so the permission-shaped
// logic (who gets the button, which tab opens first, what the viewer can show)
// is unit-testable without rendering — see
// tests/video/call-materials-panel.logic.test.ts.

/** Can CallMaterialViewer show this material in place, on the call stage?
 *
 * The ONE answer to that question: it decides both what the picker labels
 * "opens outside the call" and where a pick is routed — to the viewer (and so
 * to the open-for choice sheet, which is only ever offered for something the
 * other person could actually be shown) or out to a browser tab. Two call
 * sites that answered it separately would eventually disagree, and the visible
 * form of that is a row promising to open in the call that then opens a tab.
 *
 * `fileKind` is resolved server-side from the stored filename
 * (materialFileKind); a file that predates it, or arrives over the data
 * channel from an older build, has it null and keeps opening externally. */
export function rendersInCall(m: Pick<CallMaterial, "kind" | "fileKind" | "viewUrl">): boolean {
  if (m.kind === "content") return true;
  if (m.kind !== "file" || !m.viewUrl) return false;
  return m.fileKind === "pdf" || m.fileKind === "image";
}
export function shouldShowMaterialsControl(
  materialsCount: number,
  canBrowseLibrary: boolean,
): boolean {
  return materialsCount > 0 || canBrowseLibrary;
}

export function initialMaterialsTab(materialsCount: number): "class" | "library" {
  return materialsCount > 0 ? "class" : "library";
}
