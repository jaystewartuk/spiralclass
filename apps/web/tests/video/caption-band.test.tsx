// @vitest-environment jsdom
//
// CaptionBand — the live-subtitle surface. These pin the decisions that make
// it a LANGUAGE LESSON's subtitles rather than a meeting's, each of which a
// refactor could quietly undo without breaking anything visibly:
//
//   1. In "both" mode the ORIGINAL is the prominent line, not the
//      translation. The learner is listening to those exact words; the text
//      she matches to the sound has to be the text she reads first. Losing
//      this would leave the mode present and pedagogically pointless.
//      "both" is not the shipped default — the default is the translation
//      alone, aimed at a reader who has never chosen (see preferences.ts) —
//      so most of the cases below ask for it explicitly through
//      BOTH_LANGUAGES rather than inheriting it.
//   2. The band announces itself to a screen reader (role="log" +
//      aria-live), and each line carries its own `lang`. Without the
//      attribute a reader speaks Spanish with English phonemes — on the one
//      feature most likely to be used by someone who depends on it.
//   3. The reader's own preferences are honoured, including "hide it", which
//      is the control a student had no way to reach at all before.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import type { CaptionEntry } from "@/lib/captions/caption-feed";
import { DEFAULT_CAPTION_PREFERENCES } from "@/lib/captions/preferences";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { CaptionBand } = await import("@/components/video/caption-band");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// What the band renders once a reader has opted into both languages. Most of
// what this file pins is bilingual layout — which line is prominent, how many
// survive a small screen, how they scale together — and none of that is
// reachable from the shipped default. Spelling it out here also means a change
// to the DEFAULT is a one-line change to this file's expectations rather than
// a diff across twelve cases.
const BOTH_LANGUAGES = { ...DEFAULT_CAPTION_PREFERENCES, display: "both" } as const;

const bilingual: CaptionEntry = {
  id: "1",
  text: "How are you today?",
  src: "¿Cómo estás hoy?",
  from: "teacher-1",
  lang: "en",
  srcLang: "es",
  at: 1_000,
};

function render(props: Partial<React.ComponentProps<typeof CaptionBand>> = {}) {
  act(() =>
    root.render(
      <CaptionBand
        entries={[bilingual]}
        prefs={BOTH_LANGUAGES}
        onPrefsChange={() => {}}
        speakerName={(id) => (id === "teacher-1" ? "Mira" : null)}
        tileParked={false}
        awaitingFirstLine={false}
        hasTranscript
        onOpenTranscript={() => {}}
        {...props}
      />,
    ),
  );
  return container;
}

describe("what the band shows", () => {
  it('shows the original AND the translation in "both" mode', () => {
    const el = render();
    expect(el.textContent).toContain("¿Cómo estás hoy?");
    expect(el.textContent).toContain("How are you today?");
  });

  it("shows the translation alone on the shipped default", () => {
    // The reader this reaches is the one who has never chosen: a first-time
    // viewer, for whom two languages at once is the wrong first thing to see.
    // Pinned here as well as in caption-preferences.test.ts because that test
    // pins the VALUE and this one pins what the value does on screen.
    const el = render({ prefs: DEFAULT_CAPTION_PREFERENCES });
    expect(el.textContent).toContain("How are you today?");
    expect(el.textContent).not.toContain("¿Cómo estás hoy?");
  });

  it("makes the ORIGINAL the prominent line, not the translation", () => {
    // The whole pedagogical claim of this band. If a refactor ever swaps
    // these, subtitles quietly stop teaching and start merely explaining.
    const el = render();
    const original = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("¿Cómo estás hoy?"),
    );
    const translation = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("How are you today?"),
    );
    expect(original?.className).toContain("text-lg");
    expect(translation?.className).toContain("text-sm");
  });

  it("names the speaker", () => {
    expect(render().textContent).toContain("Mira");
  });

  it("names a speaker once per turn, not once per line", () => {
    // A run of lines from one person is one turn. Repeating the name on each
    // is noise, and it pushes the words themselves down the panel.
    const el = render({
      entries: [bilingual, { ...bilingual, id: "2", text: "And with whom?", src: "¿Y con quién?" }],
    });
    expect(el.textContent?.match(/Mira/g)).toHaveLength(1);
  });

  it("re-names the speaker when the turn changes hands", () => {
    const el = render({
      entries: [
        bilingual,
        { ...bilingual, id: "2", from: "student-1", text: "Very well.", src: "Muy bien." },
        { ...bilingual, id: "3", text: "Good.", src: "Bien." },
      ],
      speakerName: (id) => (id === "teacher-1" ? "Mira" : "Diego"),
    });
    expect(el.textContent?.match(/Mira/g)).toHaveLength(2);
    expect(el.textContent?.match(/Diego/g)).toHaveLength(1);
  });

  it("shows at most two lines on a phone, whatever the size step allows", () => {
    // A third line of bilingual text is six more wrapped lines over a video
    // that is already small. The oldest is hidden below `lg` rather than
    // dropped, so a laptop still gets the full run.
    const three = [
      bilingual,
      { ...bilingual, id: "2", src: "Segunda", text: "Second" },
      { ...bilingual, id: "3", src: "Tercera", text: "Third" },
    ];
    // The line elements are the direct children of the live region, so query
    // there — the outer container also "contains" every line's text.
    const lines = [...(render({ entries: three }).querySelector('[role="log"]')?.children ?? [])];
    expect(lines).toHaveLength(3);
    const oldest = lines.find((d) => d.textContent?.includes("¿Cómo estás hoy?"));
    expect(oldest?.className).toContain("hidden");
    expect(oldest?.className).toContain("lg:block");
    // The two most recent are never hidden.
    expect(lines.find((d) => d.textContent?.includes("Tercera"))?.className).not.toContain(
      "hidden",
    );
    expect(lines.find((d) => d.textContent?.includes("Segunda"))?.className).not.toContain(
      "hidden",
    );
  });

  it("shows fewer lines as the text gets bigger", () => {
    // Three lines of extra-large bilingual text is a wall across the other
    // person's face. Someone who asked for bigger text asked to read, not to
    // read more at once.
    const three = [
      bilingual,
      { ...bilingual, id: "2", src: "Segunda", text: "Second" },
      { ...bilingual, id: "3", src: "Tercera", text: "Third" },
    ];
    expect(render({ entries: three }).textContent).toContain("¿Cómo estás hoy?");
    const big = render({
      entries: three,
      prefs: { ...BOTH_LANGUAGES, size: "xl" },
    });
    expect(big.textContent).not.toContain("¿Cómo estás hoy?");
    expect(big.textContent).toContain("Tercera");
  });

  it("falls back to a neutral label for a speaker the room no longer knows", () => {
    // Someone who left mid-line. Printing a raw participant id here would be
    // a UUID over the video.
    const el = render({ speakerName: () => null });
    expect(el.textContent).toContain("call.captionsSpeakerUnknown");
    expect(el.textContent).not.toContain("teacher-1");
  });

  it("shows the translation at full size when there is no original", () => {
    // The Agent omits `src` when the translation came back unchanged, so a
    // single-line card is routine — and must not render at the small
    // secondary size meant for a supporting line.
    const el = render({ entries: [{ ...bilingual, src: undefined }] });
    const p = [...el.querySelectorAll("p")].find((n) =>
      n.textContent?.includes("How are you today?"),
    );
    expect(p?.className).toContain("text-lg");
  });

  it("says it is listening once captions are on but before the first line", () => {
    // The gap between the teacher flipping the switch and ASR + translation
    // returning. Silence there is indistinguishable from a broken feature.
    const el = render({ entries: [], awaitingFirstLine: true });
    expect(el.textContent).toContain("call.captionsListening");
  });

  it("renders nothing at all when idle, rather than an invisible box", () => {
    // An always-present wrapper over the video is the exact bug the
    // notes-overlay had: it paints nothing but still sits over the stage.
    const el = render({ entries: [], awaitingFirstLine: false });
    expect(el.innerHTML).toBe("");
  });
});

describe("accessibility", () => {
  it("is a polite live region so a screen reader speaks new lines", () => {
    const region = render().querySelector('[role="log"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("tags each line with its own language", () => {
    const el = render();
    const original = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("¿Cómo estás hoy?"),
    );
    const translation = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("How are you today?"),
    );
    expect(original?.getAttribute("lang")).toBe("es");
    expect(translation?.getAttribute("lang")).toBe("en");
  });
});

describe("the reader's preferences", () => {
  it("renders nothing when the reader has hidden subtitles", () => {
    // The control a student never had: the room switch is her teacher's, but
    // whether the band covers the video is hers.
    const el = render({ prefs: { ...BOTH_LANGUAGES, visible: false } });
    expect(el.innerHTML).toBe("");
  });

  it("shows only the translation on request", () => {
    const el = render({ prefs: { ...BOTH_LANGUAGES, display: "translation" } });
    expect(el.textContent).toContain("How are you today?");
    expect(el.textContent).not.toContain("¿Cómo estás hoy?");
  });

  it("shows only the original on request", () => {
    const el = render({ prefs: { ...BOTH_LANGUAGES, display: "original" } });
    expect(el.textContent).toContain("¿Cómo estás hoy?");
    expect(el.textContent).not.toContain("How are you today?");
  });

  it("scales both lines together at a larger text size", () => {
    const el = render({ prefs: { ...BOTH_LANGUAGES, size: "xl" } });
    const original = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("¿Cómo estás hoy?"),
    );
    const translation = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("How are you today?"),
    );
    expect(original?.className).toContain("text-3xl");
    expect(translation?.className).toContain("text-xl");
  });

  it("stays anchored to the BOTTOM whether or not a tile is parked", () => {
    // The regression this exists for, reported from a real call on a laptop
    // and an Android phone: the band used to dodge the corner camera tile by
    // moving UP by the tile's height, which surrendered 166px across the full
    // width of the stage and put the subtitles in the middle of the screen.
    // Subtitles keep the bottom edge; the tile is cleared sideways.
    for (const tileParked of [true, false]) {
      const band = render({ tileParked }).firstElementChild as HTMLElement;
      expect(band.className).toContain("bottom-3");
      expect(band.className).not.toContain("top-");
      // No inline offset at all any more — that was the mechanism that moved it.
      expect(band.style.bottom).toBe("");
    }
  });

  it("reserves the parked tile's column, and only on a narrow screen", () => {
    // 110px wide at right:16, so pr-32 (128px) clears it. Above lg a centred
    // max-w-3xl band cannot reach the corner, so it would be wasted width.
    const parked = render({ tileParked: true }).firstElementChild as HTMLElement;
    expect(parked.className).toContain("pr-32");
    expect(parked.className).toContain("lg:pr-4");

    const clear = render({ tileParked: false }).firstElementChild as HTMLElement;
    expect(clear.className).not.toContain("pr-32");
  });
});
