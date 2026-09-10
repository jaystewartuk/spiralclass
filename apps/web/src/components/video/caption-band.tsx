"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ScrollText, Settings2, Type, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import type { CaptionEntry } from "@/lib/captions/caption-feed";
import type { CaptionDisplay, CaptionPreferences, CaptionSize } from "@/lib/captions/preferences";

// The live-subtitle surface. Three pieces, in the order a reader meets them:
// the band over the video, the settings popover that band owns, and the
// transcript sheet it can open.
//
// WHAT CHANGED AND WHY. The previous band was three stacked <p>s of the
// translated line, pinned 16px from the bottom of the stage. It worked, and
// it was a meeting's captions, not a language lesson's:
//
//   1. It showed the TRANSLATION ONLY. The Agent had the verbatim source
//      text — Deepgram produces it and Claude is handed it — and dropped it
//      on the floor. On a platform whose entire product is one person
//      teaching another a language, the sentence the speaker actually
//      produced is the lesson; the translation is the gloss that makes it
//      comprehensible. Showing only the gloss teaches nothing.
//   2. It never said WHO SPOKE. Fine in the common case and wrong in the
//      one that matters: a teacher captioning her student's attempt at a new
//      language wants no ambiguity about whose sentence she is reading.
//   3. It sat at a fixed `bottom-4`, under the first-run privacy card at
//      `bottom-24` and, on a narrow window, under the floating self-view
//      tile. The notice moved to the middle of the stage; the tile is
//      cleared sideways (see `tileParked`) rather than by moving the band
//      up the screen, which is a mistake this file made once already and
//      which cost a third of a phone's video area — subtitles keep the
//      bottom edge.
//   4. It was invisible to a screen reader — no live region, so a
//      hard-of-hearing user running one got silence from the one feature
//      built for them.
//   5. The READER had no control over any of it. Not the size, not whether
//      it covered the other person's face, not whether it was there at all.
//      The only switch in the product is the teacher's room-wide one, which
//      is a privacy decision and rightly hers — but it left a student with
//      subtitles she could not move, resize or dismiss.
//
// Everything below is a response to one of those five.

export type CaptionBandProps = {
  entries: CaptionEntry[];
  prefs: CaptionPreferences;
  onPrefsChange: (patch: Partial<CaptionPreferences>) => void;
  // Resolves a speaker's participant identity to a display name. Returns null
  // for an identity the room no longer knows (someone who left mid-line), and
  // the band falls back to a neutral label rather than printing a raw id.
  speakerName: (identity: string) => string | null;
  // Whether a floating camera tile is parked in the stage's bottom-right
  // corner. The band keeps clear of it SIDEWAYS — it reserves the tile's
  // column, and only on screens narrow enough that a centred band would
  // otherwise reach it.
  //
  // This was a vertical offset, and that was the wrong axis. Stepping the
  // band up by the tile's height gave away 166px across the whole width of
  // the stage to dodge a 110px-wide corner, which on a phone put the
  // subtitles in the middle of the screen. Subtitles keep the bottom edge; a
  // corner obstruction gets a corner-shaped answer.
  tileParked: boolean;
  // True once the room is captioning but before the first line lands. ASR
  // plus translation is a second or two, and silence in that gap reads as
  // "it didn't work" — this is the difference between a feature that feels
  // broken and one that feels like it is listening.
  awaitingFirstLine: boolean;
  onOpenTranscript: () => void;
  hasTranscript: boolean;
};

// Type sizes for the two lines, and how many lines the band shows at that
// size. A step here changes both text sizes together, so the
// original/translation hierarchy holds as the whole band scales. `xl` exists
// because "make the subtitles bigger" is the single most common
// accessibility request captions get, and the old band had no answer.
//
// `maxLines` shrinks as the type grows. Three lines of extra-large bilingual
// text is roughly a dozen lines of wrapped copy — it stops being a subtitle
// band and becomes a wall across the other person's face. Someone who has
// asked for bigger text has asked to read, not to read MORE at once.
const SIZE_CLASSES: Record<CaptionSize, { primary: string; secondary: string; maxLines: number }> =
  {
    m: { primary: "text-lg", secondary: "text-sm", maxLines: 3 },
    l: { primary: "text-2xl", secondary: "text-base", maxLines: 2 },
    xl: { primary: "text-3xl", secondary: "text-xl", maxLines: 2 },
  };

export function CaptionBand({
  entries,
  prefs,
  onPrefsChange,
  speakerName,
  tileParked,
  awaitingFirstLine,
  onOpenTranscript,
  hasTranscript,
}: CaptionBandProps) {
  const t = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
  const controlsRef = useRef<HTMLDivElement>(null);
  const sizes = SIZE_CLASSES[prefs.size];
  // The feed hands over everything still inside its lifetime; the band
  // decides how much of that fits at the reader's chosen type size.
  const shown = entries.slice(-sizes.maxLines);

  // Nothing to show and nothing to say: render no element at all, so the
  // stage is genuinely clear rather than holding an invisible box over the
  // video (the same mistake the notes-overlay wrapper made — see the
  // overlay comment in class-call.tsx).
  const idle = shown.length === 0 && !awaitingFirstLine;
  if (!prefs.visible || idle) return null;

  return (
    <div
      // ANCHORED TO THE BOTTOM, always. The column is capped at the same
      // max-width as the panel below it, so the controls right-align with the
      // SUBTITLES rather than with the viewport — anchored to the viewport
      // edge they read as unrelated floating chrome.
      //
      // `pr-32` is the parked tile's column (110px wide at `right: 16`, so
      // 128px clears it), and it applies only below `lg`. Above 1024px a
      // centred max-w-3xl band cannot reach the corner anyway — the arithmetic
      // is (stageWidth - 768) / 2 > 126, which is true from about 1020px — so
      // reserving the column there would narrow the subtitles for nothing.
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-3 z-20 mx-auto flex max-w-3xl flex-col items-center gap-1 pl-3 lg:bottom-4 lg:gap-1.5 lg:pl-4",
        tileParked ? "pr-32 lg:pr-4" : "pr-3 lg:pr-4",
      )}
    >
      {/* The band's own controls, anchored to the band rather than buried in
      the control row below the stage. Subtitle settings are read WHILE
      reading subtitles — putting them where the text is means the adjustment
      and its effect are in the same glance. Kept low-contrast until
      hover/focus so they never compete with the words.

      controlsRef spans the buttons AND the popover, and the click-outside
      check tests against this whole element rather than the popover alone.
      Testing only the popover would make the settings button itself
      "outside": its own pointerdown would close the popover in the capture
      phase and its click would immediately reopen it, so the control would
      look dead. */}
      <div
        ref={controlsRef}
        className="pointer-events-auto relative flex items-center gap-1 self-end"
      >
        {settingsOpen && (
          <CaptionSettings
            id={settingsId}
            prefs={prefs}
            onChange={onPrefsChange}
            onClose={() => setSettingsOpen(false)}
            outsideOf={controlsRef}
          />
        )}
        {hasTranscript && (
          <BandButton
            onClick={onOpenTranscript}
            label={t("call.captionsTranscript")}
            icon={<ScrollText className="h-4 w-4" aria-hidden />}
          />
        )}
        <BandButton
          onClick={() => setSettingsOpen((v) => !v)}
          label={t("call.captionsSettings")}
          expanded={settingsOpen}
          controls={settingsId}
          icon={<Settings2 className="h-4 w-4" aria-hidden />}
        />
        <BandButton
          onClick={() => onPrefsChange({ visible: false })}
          label={t("call.captionsHideMine")}
          icon={<X className="h-4 w-4" aria-hidden />}
        />
      </div>

      {/* ONE panel, not one card per line. Three separately-scrimmed cards
      stacked up read as three plaques dropped on the video — at the larger
      text sizes they covered most of the other person's face, and the eye
      had to re-enter each one. A single band with the lines inside it is
      both lighter over the video and closer to how a reader actually parses
      a running transcript.

      role="log" + aria-live="polite" is what makes it readable by a screen
      reader at all. `polite`, not `assertive`: a subtitle is running
      commentary, and interrupting the user's own navigation for every
      sentence would make the call unusable. */}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t("call.captionsRegionLabel")}
        className={cn(
          // Tighter on a phone. Every one of these steps is vertical space
          // taken off the video on the screen that has least of it.
          "flex flex-col items-center gap-1.5 rounded-xl bg-scrim-3 px-3 py-2 shadow-lg backdrop-blur-xs",
          "lg:gap-2.5 lg:rounded-2xl lg:px-5 lg:py-3",
          // Full width once there is text, so successive lines do not make
          // the panel jump about as sentences change length. But the
          // "Listening…" state is two words, and stretching a full-width
          // black bar across the video to hold them reads as something being
          // wrong rather than as a quiet standby.
          shown.length > 0 ? "w-full" : "w-auto",
          // ROOM FOR THE POPOVER, and the reason it is bought HERE rather
          // than by moving the popover.
          //
          // The settings panel opens downward over this one, on the stated
          // grounds that "downward there is always room, because the panel it
          // overlays is taller than it is". That is true of three lines of
          // subtitles and false of one: with a single short line this panel is
          // ~56px, the popover needs ~150px, and the rest was sliced off by
          // the stage's own overflow — the "Text size" row lost its buttons
          // and nothing on screen said so. Reported from a real call on an
          // Android phone, 2026-09-08, with screenshots.
          //
          // Opening it upward instead is the obvious move and is already
          // ruled out two comments below, measured in a browser. So the
          // assumption is made true instead of abandoned: while the settings
          // are open this panel holds at least the popover's height, the band
          // grows upward from its bottom anchor as it always does, and the
          // popover has the room it was promised in every caption state.
          settingsOpen && "min-h-40",
        )}
      >
        {awaitingFirstLine && shown.length === 0 && (
          <ListeningLine label={t("call.captionsListening")} />
        )}
        {shown.map((entry, index) => (
          <CaptionLineView
            key={entry.id}
            entry={entry}
            latest={index === shown.length - 1}
            // A phone shows at most the last TWO, whatever the size step
            // allows on a larger screen. A third line of bilingual text is
            // six more wrapped lines over a video that is already small, and
            // the transcript is where the history properly lives.
            hiddenOnSmall={index < shown.length - 2}
            // A run of lines from one speaker is a single turn; repeating the
            // name on each is noise that pushes the words themselves down.
            showSpeaker={entry.from !== shown[index - 1]?.from}
            display={prefs.display}
            sizes={sizes}
            speakerName={speakerName}
            unknownSpeakerLabel={t("call.captionsSpeakerUnknown")}
          />
        ))}
      </div>
    </div>
  );
}

// One subtitle inside the band. The line, not the raw text, is the unit — a
// speaker label and two languages travel together, and bare stacked
// paragraphs made consecutive lines from different speakers indistinguishable.
function CaptionLineView({
  entry,
  latest,
  hiddenOnSmall,
  showSpeaker,
  display,
  sizes,
  speakerName,
  unknownSpeakerLabel,
}: {
  entry: CaptionEntry;
  latest: boolean;
  hiddenOnSmall: boolean;
  showSpeaker: boolean;
  display: CaptionDisplay;
  sizes: { primary: string; secondary: string };
  speakerName: (identity: string) => string | null;
  unknownSpeakerLabel: string;
}) {
  // WHICH LINE IS BIG. In "both" mode the ORIGINAL is the prominent one and
  // the translation sits under it — the same convention dual-subtitle
  // language study uses everywhere, and the right one here: the learner is
  // listening to those exact words, so the text she is matching to the sound
  // must be the text she reads first. The translation is there to make it
  // mean something, which is a supporting job. When there is no source (the
  // speaker was already talking in the reader's language, so the Agent sent
  // no `src`) the translation is simply the only line, at full size.
  const original = entry.src;
  const showOriginal = original != null && display !== "translation";
  const showTranslation = display !== "original" || original == null;
  const primaryIsOriginal = showOriginal;

  const name = entry.from ? speakerName(entry.from) : null;
  const label = entry.from ? (name ?? unknownSpeakerLabel) : null;

  return (
    <div
      className={cn(
        // motion-safe: the slide-up is a nicety; for a reader with reduced
        // motion set, text sliding under their eye as they start reading it
        // is the opposite of a nicety.
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2",
        "w-full text-center duration-300",
        hiddenOnSmall && "hidden lg:block",
        // Older lines recede rather than disappearing. They stay legible —
        // this is a reading aid, and a half-faded sentence you cannot finish
        // is worse than no sentence — but the newest line has to be findable
        // at a glance, so the gap between the two is a real step rather than
        // the barely-perceptible one an 80%-vs-100% white gave.
        latest ? "text-on-dark" : "text-on-dark-faint",
      )}
    >
      {label && showSpeaker && (
        <p className="mb-0.5 text-center text-sm font-semibold text-on-dark-faint">{label}</p>
      )}
      {showOriginal && (
        <p
          // `lang` on the element, not just for tidiness: a screen reader
          // switches voice for it, and without the attribute it reads
          // Spanish with an English phoneme set — unintelligible, on the
          // feature most likely to be used by someone relying on it.
          lang={entry.srcLang}
          className={cn(sizes.primary, "leading-snug font-medium")}
        >
          {original}
        </p>
      )}
      {showTranslation && (
        <p
          lang={entry.lang}
          // No colour of its own: it inherits the line's recency colour from
          // the wrapper, so an aged-out line dims as ONE thing. A fixed
          // `text-on-dark-muted` here made the translation of the oldest line
          // BRIGHTER than the original above it, inverting the hierarchy
          // exactly where it mattered least and confused most.
          className={cn(
            primaryIsOriginal
              ? cn(sizes.secondary, "mt-1 leading-snug font-normal opacity-80")
              : cn(sizes.primary, "leading-snug font-medium"),
          )}
        >
          {entry.text}
        </p>
      )}
    </div>
  );
}

// The gap between "captions are on" and the first line. Three dots that
// breathe. No scrim or shadow of its own — it sits INSIDE the band's panel,
// which already has both.
function ListeningLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-end gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-on-dark-muted motion-safe:animate-pulse"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
      <span className="text-sm text-on-dark-muted">{label}</span>
    </div>
  );
}

function BandButton({
  onClick,
  label,
  icon,
  expanded,
  controls,
}: {
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  expanded?: boolean;
  // The id of the region this button opens. Paired with aria-expanded so a
  // screen reader can say not just that something opened but what.
  controls?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls={controls}
      className="flex h-7 w-7 items-center justify-center rounded-full bg-scrim-2 text-white opacity-60 backdrop-blur-md transition hover:bg-scrim-3 hover:opacity-100 focus-visible:opacity-100 lg:h-8 lg:w-8"
    >
      {icon}
    </button>
  );
}

// Subtitle settings. A popover rather than a route into Settings: every one
// of these is a "right now, this is too small / this is in my way" decision,
// and a preference you have to leave the call to change is a preference
// nobody changes.
function CaptionSettings({
  id,
  prefs,
  onChange,
  onClose,
  // The element a pointerdown must land OUTSIDE of to dismiss. Deliberately
  // the whole controls cluster, not this popover — see the comment at its
  // ref in CaptionBand.
  outsideOf,
}: {
  id: string;
  prefs: CaptionPreferences;
  onChange: (patch: Partial<CaptionPreferences>) => void;
  onClose: () => void;
  outsideOf: React.RefObject<HTMLElement | null>;
}) {
  const t = useT();

  // Dismiss on Escape and on a click outside — the two gestures a popover
  // owes anyone who opened it mid-call and now wants their video back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stops here rather than bubbling: the call has other Escape
        // handlers (the material viewer), and closing a subtitle popover
        // must not also close the worksheet behind it.
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const root = outsideOf.current;
      if (root && !root.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    // Capture phase: the stage below has its own pointer handlers for
    // tile-drag/tap-to-swap, and a dismissing click must not also swap the
    // video the user was looking at.
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [onClose, outsideOf]);

  // Short visible labels, full phrasing as the accessible name. Both rows are
  // segmented controls of three, which is what keeps the popover SHORT enough
  // to open upward at all — see the height note on the container below.
  const displays: { value: CaptionDisplay; label: string; name: string }[] = [
    {
      value: "both",
      label: t("call.captionsDisplayBothShort"),
      name: t("call.captionsDisplayBoth"),
    },
    {
      value: "translation",
      label: t("call.captionsDisplayTranslationShort"),
      name: t("call.captionsDisplayTranslation"),
    },
    {
      value: "original",
      label: t("call.captionsDisplayOriginalShort"),
      name: t("call.captionsDisplayOriginal"),
    },
  ];
  const sizes: { value: CaptionSize; label: string }[] = [
    { value: "m", label: t("call.captionsSizeM") },
    { value: "l", label: t("call.captionsSizeL") },
    { value: "xl", label: t("call.captionsSizeXl") },
  ];

  return (
    <div
      id={id}
      // role="group", not "dialog": this is a disclosure hanging off a
      // button with aria-expanded/aria-controls, not a modal. Calling it a
      // dialog would promise focus trapping and a close affordance it
      // deliberately does not have — the call is still running behind it.
      role="group"
      aria-label={t("call.captionsSettings")}
      // OPENS DOWNWARD, over the subtitles, and that is the whole reason it
      // is positioned this way rather than the more obvious `bottom-full`.
      //
      // The trigger sits directly above the caption panel, which sits low on
      // a stage that clips its own overflow. Opening upward there means
      // competing for the headroom left above the band — and losing: measured
      // in a browser, the "Show" legend and its whole row of options were
      // simply gone off the top, with no scrollbar and nothing to suggest
      // anything was missing. Downward there is always room, because the
      // panel it overlays is taller than it is.
      //
      // Overlaying the subtitles while you adjust them is not a cost worth
      // avoiding: the popover is 256px against a panel three times that wide,
      // so the lines stay legible beside it and the change you make is
      // visible as you make it. Both rows are segmented (three across, not
      // three stacked) to keep it to ~150px; the cap is the backstop for a
      // locale whose labels wrap.
      className="absolute top-10 right-0 z-30 max-h-over-controls w-64 overflow-y-auto rounded-2xl bg-scrim-3 p-3 text-left shadow-lg backdrop-blur-md"
    >
      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold text-on-dark-faint">
          {t("call.captionsDisplayLegend")}
        </legend>
        <div className="flex gap-1.5">
          {displays.map((option) => (
            <SegmentButton
              key={option.value}
              label={option.label}
              name={option.name}
              selected={prefs.display === option.value}
              onSelect={() => onChange({ display: option.value })}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-3">
        <legend className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-on-dark-faint">
          <Type className="h-3.5 w-3.5" aria-hidden />
          {t("call.captionsSizeLegend")}
        </legend>
        <div className="flex gap-1.5">
          {sizes.map((option) => (
            <SegmentButton
              key={option.value}
              label={option.label}
              selected={prefs.size === option.value}
              onSelect={() => onChange({ size: option.value })}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}

// One segment of a three-across control. `name` carries the full phrasing for
// assistive tech when the visible label is abbreviated to fit.
function SegmentButton({
  label,
  name,
  selected,
  onSelect,
}: {
  label: string;
  name?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={name}
      title={name}
      className={cn(
        // min-h-target, not a smaller pill: D-140's touch floor applies to a
        // control someone taps mid-lesson on a phone as much as anywhere.
        // Height was never what made this popover too tall — three of these
        // stacked was.
        "min-h-target flex-1 rounded-lg px-1.5 text-center text-sm leading-tight font-medium transition",
        selected ? "bg-overlay-4 text-scrim-3" : "bg-overlay-1 text-white hover:bg-overlay-2",
      )}
    >
      {label}
    </button>
  );
}

// The transcript. The reason this is worth building rather than "nice to
// have": speech is the one part of a lesson with no scrollback. Homework,
// materials and notes all persist; the sentence the teacher said forty
// seconds ago does not, and "sorry, what was that?" is the most expensive
// interruption in a paid lesson hour.
//
// Lives entirely in this browser tab for the length of the call. Nothing is
// written to the server, which is what lets the privacy notice keep saying
// nothing is stored — and is why the panel says so itself rather than
// leaving a student to assume her teacher is keeping a record.
export function CaptionTranscript({
  entries,
  speakerName,
  onClose,
}: {
  entries: CaptionEntry[];
  speakerName: (identity: string) => string | null;
  onClose: () => void;
}) {
  const t = useT();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the live edge, but ONLY while the reader is already at it. Someone
  // who has scrolled up is reading something; yanking them back to the bottom
  // every time the teacher finishes a sentence would make the panel useless
  // for the exact thing it is for.
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    if (pinned) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, pinned]);

  // Escape closes it. The panel covers a third of the stage, so the fastest
  // way back to the other person's face has to be a key, not a hunt for the
  // × in the corner.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const startedAt = entries[0]?.at;
  const clock = useMemo(() => {
    if (startedAt == null) return () => "";
    return (at: number) => {
      // Elapsed-since-first-caption, not wall clock: "at 12:47" means nothing
      // when you are trying to find a moment inside a lesson.
      const total = Math.max(0, Math.round((at - startedAt) / 1000));
      const mm = Math.floor(total / 60);
      const ss = total % 60;
      return `${mm}:${ss.toString().padStart(2, "0")}`;
    };
  }, [startedAt]);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={t("call.captionsTranscript")}
      className="absolute top-0 right-0 bottom-0 z-30 flex w-full max-w-sm flex-col bg-scrim-3 shadow-lg backdrop-blur-md"
    >
      {/* The title and the close button share a row; the privacy line sits
      BELOW them at full width. Nested under the title it wrapped to two
      lines against the close button and made the header look cramped — and
      it is the sentence that tells a student nobody is keeping a record of
      her lesson, so it should not be the thing that gets squeezed. */}
      <div className="border-b border-overlay-1 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-white">{t("call.captionsTranscript")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("call.materialsClose")}
            title={t("call.materialsClose")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-overlay-1 text-white hover:bg-overlay-2"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="mt-1 text-sm text-on-dark-faint">{t("call.captionsTranscriptPrivacy")}</p>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
      >
        {entries.length === 0 ? (
          <p className="text-sm text-on-dark-faint">{t("call.captionsTranscriptEmpty")}</p>
        ) : (
          entries.map((entry) => {
            const name = entry.from ? speakerName(entry.from) : null;
            return (
              <div key={entry.id} className="text-sm">
                <p className="flex items-center gap-2 text-sm text-on-dark-faint">
                  <span className="font-mono">{clock(entry.at)}</span>
                  {name && <span className="font-medium">{name}</span>}
                </p>
                {entry.src && (
                  <p lang={entry.srcLang} className="leading-snug font-medium text-on-dark">
                    {entry.src}
                  </p>
                )}
                <p lang={entry.lang} className="leading-snug text-on-dark-muted">
                  {entry.text}
                </p>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
