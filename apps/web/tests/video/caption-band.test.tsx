// @vitest-environment jsdom
//
// CaptionBand — the live-subtitle surface. These pin the decisions that make
// it a LANGUAGE LESSON's subtitles rather than a meeting's, each of which a
// refactor could quietly undo without breaking anything visibly:
//
//   1. One language per subtitle, never two. Original-above-translation was
//      removed because the one teacher using it found two languages in one
//      place confusing; the translation is the default and the original is
//      the opt-in for a reader testing herself (see preferences.ts).
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

const { CaptionBand, CaptionTranscript } = await import("@/components/video/caption-band");

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
        prefs={DEFAULT_CAPTION_PREFERENCES}
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
  it("shows the translation alone on the shipped default", () => {
    // Pinned here as well as in caption-preferences.test.ts because that test
    // pins the VALUE and this one pins what the value does on screen.
    const el = render({ prefs: DEFAULT_CAPTION_PREFERENCES });
    expect(el.textContent).toContain("How are you today?");
    expect(el.textContent).not.toContain("¿Cómo estás hoy?");
  });

  it("never puts the original and the translation on screen together", () => {
    for (const display of ["translation", "original"] as const) {
      const el = render({ prefs: { ...DEFAULT_CAPTION_PREFERENCES, display } });
      const lines = [...el.querySelectorAll("p")].filter(
        (p) =>
          p.textContent?.includes("¿Cómo estás hoy?") ||
          p.textContent?.includes("How are you today?"),
      );
      expect(lines).toHaveLength(1);
    }
  });

  it("offers only the translation and the original in its settings", () => {
    const el = render();
    act(() => (el.querySelector('[aria-label="call.captionsSettings"]') as HTMLElement).click());
    const group = el.querySelector('[role="group"]') as HTMLElement;
    expect(group.querySelector('[aria-label="call.captionsDisplayTranslation"]')).not.toBeNull();
    expect(group.querySelector('[aria-label="call.captionsDisplayOriginal"]')).not.toBeNull();
    expect(group.textContent).not.toContain("captionsDisplayBoth");
  });

  it("is a size larger on a computer screen at the default size", () => {
    // A student on a desktop could not read the default-size subtitles and
    // never found the size control; the default now scales up from `md`.
    const el = render({ prefs: DEFAULT_CAPTION_PREFERENCES });
    const line = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("How are you today?"),
    );
    expect(line?.className).toContain("text-lg");
    expect(line?.className).toContain("md:text-2xl");
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
    const oldest = lines.find((d) => d.textContent?.includes("How are you today?"));
    expect(oldest?.className).toContain("hidden");
    expect(oldest?.className).toContain("lg:block");
    // The two most recent are never hidden.
    expect(lines.find((d) => d.textContent?.includes("Third"))?.className).not.toContain("hidden");
    expect(lines.find((d) => d.textContent?.includes("Second"))?.className).not.toContain("hidden");
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
    expect(render({ entries: three }).textContent).toContain("How are you today?");
    const big = render({
      entries: three,
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, size: "xl" },
    });
    expect(big.textContent).not.toContain("How are you today?");
    expect(big.textContent).toContain("Third");
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
    const original = render({
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, display: "original" },
    }).querySelector("p[lang]");
    expect(original?.textContent).toContain("¿Cómo estás hoy?");
    expect(original?.getAttribute("lang")).toBe("es");
    const translation = render().querySelector("p[lang]");
    expect(translation?.textContent).toContain("How are you today?");
    expect(translation?.getAttribute("lang")).toBe("en");
  });
});

// D-198: the words of a phrase are on screen while it is being said.
describe("words still being spoken", () => {
  const partial: CaptionEntry = {
    id: "1",
    text: "¿Cómo estás",
    from: "teacher-1",
    lang: "es",
    partial: true,
    at: 1_000,
  };

  it.each(["translation", "original"] as const)(
    'shows them, in the speaker\'s language, in "%s" mode',
    (display) => {
      const el = render({ entries: [partial], prefs: { ...DEFAULT_CAPTION_PREFERENCES, display } });
      const p = [...el.querySelectorAll("p")].find((n) => n.textContent === "¿Cómo estás");
      expect(p?.getAttribute("lang")).toBe("es");
    },
  );

  it("keeps them from a screen reader, which hears the finished line", () => {
    const el = render({ entries: [partial] });
    const line = [...el.querySelectorAll("p")].find((n) => n.textContent === "¿Cómo estás");
    expect(line?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("puts the finished line in as a new line, so the log announces it", () => {
    const el = render({ entries: [partial] });
    const before = [...el.querySelectorAll("p")].find((n) => n.textContent === "¿Cómo estás");
    render({ entries: [bilingual] });
    const after = [...el.querySelectorAll("p")].find(
      (n) => n.textContent === "How are you today?" || n.textContent === "Mira¿Cómo estás hoy?",
    );
    expect(after).toBeDefined();
    expect(before?.isConnected).toBe(false);
    expect(after?.closest('[aria-hidden="true"]')).toBeNull();
  });
});

// D-206. A teacher and her student, testing the one-language band, still saw
// two languages: the untranslated words of the phrase being spoken under the
// translation of the last one. A reader of a translation now gets a wordless
// partial, and the band shows the speaker as talking.
describe("a phrase still being spoken, for a reader of the translation", () => {
  const speaking: CaptionEntry = {
    id: "2",
    text: "",
    from: "teacher-1",
    lang: "en",
    partial: true,
    at: 2_000,
  };

  it("shows dots under the speaker's name, and no words", () => {
    const el = render({ entries: [speaking] });
    expect(el.querySelector("[data-caption-dots]")).not.toBeNull();
    expect(el.textContent).toBe("Mira");
  });

  it("never leaves two languages on screen under the last translated line", () => {
    for (const display of ["translation", "original"] as const) {
      const el = render({
        entries: [bilingual, speaking],
        prefs: { ...DEFAULT_CAPTION_PREFERENCES, display },
      });
      const langs = new Set([...el.querySelectorAll("[lang]")].map((n) => n.getAttribute("lang")));
      expect(langs.size).toBe(1);
    }
  });
});

describe("the reader's preferences", () => {
  it("renders nothing when the reader has hidden subtitles", () => {
    // The control a student never had: the room switch is her teacher's, but
    // whether the band covers the video is hers.
    const el = render({ prefs: { ...DEFAULT_CAPTION_PREFERENCES, visible: false } });
    expect(el.innerHTML).toBe("");
  });

  it("shows only the translation on request", () => {
    const el = render({ prefs: { ...DEFAULT_CAPTION_PREFERENCES, display: "translation" } });
    expect(el.textContent).toContain("How are you today?");
    expect(el.textContent).not.toContain("¿Cómo estás hoy?");
  });

  it("shows only the original on request", () => {
    const el = render({ prefs: { ...DEFAULT_CAPTION_PREFERENCES, display: "original" } });
    expect(el.textContent).toContain("¿Cómo estás hoy?");
    expect(el.textContent).not.toContain("How are you today?");
  });

  it("scales the line at a larger text size", () => {
    const el = render({ prefs: { ...DEFAULT_CAPTION_PREFERENCES, size: "xl" } });
    const translation = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("How are you today?"),
    );
    expect(translation?.className).toContain("text-3xl");
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

// The band while a material or a screen share fills the stage. It used not to
// exist there at all: a teacher reading a worksheet with her student had no
// subtitles and no way to open the transcript (a real class, 2026-10-02).
describe("docked under a material", () => {
  it("is a row in the layout, not an overlay on the material", () => {
    const band = render({ docked: true }).firstElementChild as HTMLElement;
    expect(band.dataset.docked).toBe("true");
    // In flow: this is what makes the stage above give up the height, rather
    // than the subtitles covering the last lines of the worksheet.
    expect(band.className).not.toMatch(/\babsolute\b/);
    expect(band.className).not.toContain("bottom-3");
    expect(band.className).not.toContain("pointer-events-none");
  });

  it("keeps its strip between sentences, so the material does not jump", () => {
    const html = render({ docked: true, entries: [], awaitingFirstLine: false });
    const log = html.querySelector('[role="log"]') as HTMLElement;
    expect(log).not.toBeNull();
    // Held open by one invisible subtitle at the reader's size, not by a
    // fixed pixel floor.
    const standby = log.querySelector("[data-caption-standby]") as HTMLElement;
    expect(standby).not.toBeNull();
    expect(standby.querySelector(".invisible")?.getAttribute("aria-hidden")).toBe("true");
    expect(standby.innerHTML).toContain("text-lg");
    // The overlay's answer to the same state, for contrast, is no element.
    expect(render({ entries: [], awaitingFirstLine: false }).innerHTML).toBe("");
  });

  it("holds one subtitle's height between sentences, not the controls' column", () => {
    // The floor used to be min-h-24 to min-h-36 — sized to three buttons
    // stacked beside the text, about three times one subtitle line, all of it
    // taken from the worksheet above.
    const rows = (prefs: typeof DEFAULT_CAPTION_PREFERENCES) =>
      render({ docked: true, entries: [], prefs })
        .querySelector("[data-caption-standby] .invisible")
        ?.querySelectorAll(".h-lh").length;
    // One language per subtitle in either mode: one line of reserve.
    expect(rows(DEFAULT_CAPTION_PREFERENCES)).toBe(1);
    expect(rows({ ...DEFAULT_CAPTION_PREFERENCES, display: "original" })).toBe(1);

    const html = render({ docked: true, entries: [] });
    expect((html.querySelector('[role="log"]') as HTMLElement).className).not.toMatch(/\bmin-h-/);
    // The controls lie in a row beside the text, so they never set the height.
    const controls = html.querySelector('[aria-label="call.captionsSettings"]')
      ?.parentElement as HTMLElement;
    expect(controls.className).not.toContain("flex-col");
  });

  it("says it is listening inside the reserved line, not on a row of its own", () => {
    const html = render({ docked: true, entries: [], awaitingFirstLine: true });
    const standby = html.querySelector("[data-caption-standby]") as HTMLElement;
    expect(standby.textContent).toContain("call.captionsListening");
  });

  it("draws no panel of its own on the call's black", () => {
    const log = render({ docked: true }).querySelector('[role="log"]') as HTMLElement;
    expect(log.className).not.toContain("bg-scrim");
    expect(log.className).not.toMatch(/\bp[xy]-/);
    // Over the camera the scrim is what makes the text readable, and stays.
    const overCamera = render().querySelector('[role="log"]') as HTMLElement;
    expect(overCamera.className).toContain("bg-scrim-3");
  });

  it("names the speaker on the line itself rather than a row above it", () => {
    const html = render({ docked: true, prefs: DEFAULT_CAPTION_PREFERENCES });
    const line = [...html.querySelectorAll("p")].find((p) =>
      p.textContent?.includes(bilingual.text),
    ) as HTMLElement;
    expect(line.querySelector("span")?.textContent).toBe("Mira");
    expect([...html.querySelectorAll("p")].some((p) => p.textContent === "Mira")).toBe(false);

    // Showing the original, the name leads that line, once.
    const original = render({
      docked: true,
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, display: "original" },
    }).querySelector('p[lang="es"]') as HTMLElement;
    expect(original.querySelector("span")?.textContent).toBe("Mira");

    // Over the camera the name keeps its own row.
    const overCamera = render();
    expect([...overCamera.querySelectorAll("p")].some((p) => p.textContent === "Mira")).toBe(true);
  });

  it("keeps the transcript reachable with a material open", () => {
    const html = render({ docked: true, entries: [] });
    expect(html.querySelector('[aria-label="call.captionsTranscript"]')).not.toBeNull();
  });

  it("still goes away when the reader hides subtitles", () => {
    const html = render({
      docked: true,
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, visible: false },
    });
    expect(html.innerHTML).toBe("");
  });

  it("shows the current exchange only, whatever the size step allows", () => {
    const entries = [1, 2, 3].map((n) => ({ ...bilingual, id: String(n), text: `line ${n}` }));
    const html = render({ docked: true, entries });
    expect(html.textContent).not.toContain("line 1");
    expect(html.textContent).toContain("line 2");
    expect(html.textContent).toContain("line 3");

    // And only the current line once the text is large: two extra-large
    // bilingual lines took more of a laptop window than the worksheet kept.
    const large = render({
      docked: true,
      entries,
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, size: "xl" },
    });
    expect(large.textContent).not.toContain("line 2");
    expect(large.textContent).toContain("line 3");
  });

  it("puts the subtitles away for materials only, from the strip's own ✕", () => {
    // The teacher's follow-up: sometimes the worksheet alone. The ✕ here must
    // not be the everywhere switch — that would take the subtitles off the
    // student's face too once the worksheet closes.
    const onPrefsChange = vi.fn();
    const html = render({ docked: true, onPrefsChange });
    const hide = html.querySelector('[aria-label="call.captionsHideWithContent"]') as HTMLElement;
    expect(hide).not.toBeNull();
    expect(html.querySelector('[aria-label="call.captionsHideMine"]')).toBeNull();
    act(() => hide.click());
    expect(onPrefsChange).toHaveBeenCalledWith({ visibleWithContent: false });

    // Over the camera the same ✕ is still the everywhere switch.
    const overCamera = vi.fn();
    const band = render({ onPrefsChange: overCamera });
    act(() => (band.querySelector('[aria-label="call.captionsHideMine"]') as HTMLElement).click());
    expect(overCamera).toHaveBeenCalledWith({ visible: false });
  });

  it("leaves a way back, and the transcript, where the strip was", () => {
    const onPrefsChange = vi.fn();
    const onOpenTranscript = vi.fn();
    const html = render({
      docked: true,
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, visibleWithContent: false },
      onPrefsChange,
      onOpenTranscript,
    });
    // No subtitles and no reserved strip: the material has its height back.
    expect(html.querySelector('[role="log"]')).toBeNull();
    expect(html.textContent).not.toContain(bilingual.text);
    expect((html.firstElementChild as HTMLElement).dataset.docked).toBe("collapsed");

    const show = [...html.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("call.captionsShowMine"),
    ) as HTMLElement;
    act(() => show.click());
    expect(onPrefsChange).toHaveBeenCalledWith({ visibleWithContent: true });

    act(() =>
      (html.querySelector('[aria-label="call.captionsTranscript"]') as HTMLElement).click(),
    );
    expect(onOpenTranscript).toHaveBeenCalled();
  });

  it("does not put them away over the camera because of the materials switch", () => {
    const html = render({ prefs: { ...DEFAULT_CAPTION_PREFERENCES, visibleWithContent: false } });
    expect(html.querySelector('[role="log"]')).not.toBeNull();
  });

  it("opens its settings upward, over the material, not down into the controls", () => {
    const html = render({ docked: true });
    const settings = html.querySelector('[aria-label="call.captionsSettings"]') as HTMLElement;
    act(() => settings.click());
    const popover = html.querySelector('[role="group"]') as HTMLElement;
    expect(popover.className).toContain("bottom-full");
    expect(popover.className).not.toContain("top-10");
    // And the panel is not stretched to make room for a popover that no
    // longer opens over it.
    expect((html.querySelector('[role="log"]') as HTMLElement).className).not.toContain("min-h-40");
  });
});

describe("the transcript panel", () => {
  function renderTranscript(props: Partial<React.ComponentProps<typeof CaptionTranscript>> = {}) {
    act(() =>
      root.render(
        <CaptionTranscript
          entries={[bilingual]}
          display="translation"
          speakerName={(id) => (id === "teacher-1" ? "Mira" : null)}
          onClose={() => {}}
          {...props}
        />,
      ),
    );
    return container;
  }

  // jsdom has no layout; the panel follows the live edge by scrolling.
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  it("shows the translation alone, as the band does", () => {
    const el = renderTranscript();
    expect(el.textContent).toContain("How are you today?");
    expect(el.textContent).not.toContain("¿Cómo estás hoy?");
  });

  it("shows the original alone in the reader's original mode", () => {
    const el = renderTranscript({ display: "original" });
    expect(el.textContent).toContain("¿Cómo estás hoy?");
    expect(el.textContent).not.toContain("How are you today?");
    expect(el.querySelector('[lang="es"]')).not.toBeNull();
  });

  it("leaves out a phrase still being spoken that carries no words", () => {
    const el = renderTranscript({
      entries: [{ id: "2", text: "", from: "teacher-1", lang: "en", partial: true, at: 2_000 }],
    });
    expect(el.textContent).toContain("call.captionsTranscriptEmpty");
  });
});

// A student on a desktop: the subtitles covered part of her teacher's face.
// Every answer here is the reader's own, and none of them changes anyone
// else's screen.
describe("keeping the subtitles off the other person's face", () => {
  const three = [
    bilingual,
    { ...bilingual, id: "2", src: "Segunda", text: "Second" },
    { ...bilingual, id: "3", src: "Tercera", text: "Third" },
  ];
  const openSettings = (el: HTMLElement) => {
    act(() => (el.querySelector('[aria-label="call.captionsSettings"]') as HTMLElement).click());
    return el.querySelector('[role="group"]') as HTMLElement;
  };
  const pointer = (target: Element, type: string, clientY: number) =>
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY, button: 0 }));
    });

  it("has a size below the default", () => {
    const el = render({ prefs: { ...DEFAULT_CAPTION_PREFERENCES, size: "s" } });
    const line = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("How are you today?"),
    );
    expect(line?.className).toContain("text-base");
    expect(line?.className).toContain("md:text-lg");
    const small = openSettings(el).querySelector('[aria-label="call.captionsSizeS"]');
    expect(small?.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows sizes as a growing glyph, named in full, so no language overflows the row", () => {
    // In Spanish "Muy grande" ran off the popover's edge, and in English
    // "Extra large" wrapped inside its segment (seen in a local call).
    const group = openSettings(render());
    const keys = [
      "call.captionsSizeS",
      "call.captionsSizeM",
      "call.captionsSizeL",
      "call.captionsSizeXl",
    ];
    for (const key of keys) {
      const button = group.querySelector(`[aria-label="${key}"]`) as HTMLElement;
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).not.toBeNull();
    }
  });

  it("shows only as many lines as the reader asked for", () => {
    const one = render({ entries: three, prefs: { ...DEFAULT_CAPTION_PREFERENCES, lines: 1 } });
    expect(one.textContent).toContain("Third");
    expect(one.textContent).not.toContain("Second");
    const two = render({ entries: three, prefs: { ...DEFAULT_CAPTION_PREFERENCES, lines: 2 } });
    expect(two.textContent).toContain("Second");
    expect(two.textContent).not.toContain("How are you today?");
  });

  it("never shows more lines than the size allows, whatever was asked", () => {
    // Three lines of extra-large text is the wall across a face that the size
    // ceiling exists to prevent; asking for three does not lift it.
    const el = render({
      entries: three,
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, size: "xl", lines: 3 },
    });
    expect(el.textContent).not.toContain("How are you today?");
  });

  it("offers only the line counts that would change something", () => {
    const group = openSettings(render({ prefs: { ...DEFAULT_CAPTION_PREFERENCES, size: "xl" } }));
    expect(group.querySelector('[aria-label="call.captionsLinesName"]')).not.toBeNull();
    const counts = [...group.querySelectorAll("button")]
      .map((b) => b.textContent)
      .filter((t) => /^\d$/.test(t ?? ""));
    expect(counts).toEqual(["1", "2"]);
    // A stored 3 reads as the 2 that is actually showing.
    const two = [...group.querySelectorAll("button")].find((b) => b.textContent === "2");
    expect(two?.getAttribute("aria-pressed")).toBe("true");
  });

  it("sets the line count and the position from its settings", () => {
    const onPrefsChange = vi.fn();
    const group = openSettings(render({ onPrefsChange }));
    act(() =>
      (
        [...group.querySelectorAll("button")].find((b) => b.textContent === "1") as HTMLElement
      ).click(),
    );
    expect(onPrefsChange).toHaveBeenCalledWith({ lines: 1 });
    for (const [key, position] of [
      ["call.captionsPositionTop", "top"],
      ["call.captionsPositionBelow", "below"],
      ["call.captionsPositionBottom", "bottom"],
    ] as const) {
      act(() => (group.querySelector(`[aria-label="${key}"]`) as HTMLElement).click());
      expect(onPrefsChange).toHaveBeenCalledWith({ position });
    }
  });

  it("sits along the top edge when moved there, panel first and controls under it", () => {
    const band = render({
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, position: "top" },
      tileParked: true,
    }).firstElementChild as HTMLElement;
    expect(band.dataset.position).toBe("top");
    expect(band.className).toContain("top-3");
    expect(band.className).toContain("flex-col-reverse");
    expect(band.className).not.toContain("bottom-3");
    // Tiles park at the bottom; reserving their column up here would narrow
    // the subtitles for nothing.
    expect(band.className).not.toContain("pr-32");
  });

  it("does not stretch the panel for the popover at the top, where it drops into the stage", () => {
    const el = render({ prefs: { ...DEFAULT_CAPTION_PREFERENCES, position: "top" } });
    openSettings(el);
    expect((el.querySelector('[role="log"]') as HTMLElement).className).not.toContain("min-h-40");
    // At the bottom it still does, so the popover is not clipped by the stage.
    const bottom = render();
    openSettings(bottom);
    expect((bottom.querySelector('[role="log"]') as HTMLElement).className).toContain("min-h-40");
  });

  it("moves to the other edge with one press of its move button", () => {
    const onPrefsChange = vi.fn();
    const el = render({ onPrefsChange });
    act(() => (el.querySelector('[aria-label="call.captionsMoveToTop"]') as HTMLElement).click());
    expect(onPrefsChange).toHaveBeenCalledWith({ position: "top" });

    const back = vi.fn();
    const top = render({
      onPrefsChange: back,
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, position: "top" },
    });
    act(() =>
      (top.querySelector('[aria-label="call.captionsMoveToBottom"]') as HTMLElement).click(),
    );
    expect(back).toHaveBeenCalledWith({ position: "bottom" });
  });

  it("snaps to the half of the stage it is dragged into, and only once", () => {
    container.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, height: 400, left: 0, right: 600, width: 600 }) as DOMRect;
    const onPrefsChange = vi.fn();
    const el = render({ onPrefsChange });
    const handle = el.querySelector('[aria-label="call.captionsMoveToTop"]') as HTMLElement;
    const band = el.firstElementChild as HTMLElement;

    pointer(handle, "pointerdown", 380);
    pointer(handle, "pointermove", 100);
    // The band follows the pointer while it is held.
    expect(band.style.transform).toBe("translateY(-280px)");
    pointer(handle, "pointerup", 100);
    // The click that ends a drag must not also toggle it back.
    act(() => handle.click());
    expect(onPrefsChange.mock.calls).toEqual([[{ position: "top" }]]);
    expect(band.style.transform).toBe("");

    // Let go in the lower half and it stays at the bottom.
    const stay = vi.fn();
    const again = render({ onPrefsChange: stay });
    const h = again.querySelector('[aria-label="call.captionsMoveToTop"]') as HTMLElement;
    pointer(h, "pointerdown", 380);
    pointer(h, "pointermove", 300);
    pointer(h, "pointerup", 300);
    expect(stay).toHaveBeenCalledWith({ position: "bottom" });
  });

  it("does not let a drag on the subtitles reach the stage's tile-swap handler", () => {
    // The stage's handler is a React prop on an ancestor, as in class-call.tsx.
    const stage = vi.fn();
    act(() =>
      root.render(
        <div onPointerDown={stage}>
          <CaptionBand
            entries={[bilingual]}
            prefs={DEFAULT_CAPTION_PREFERENCES}
            onPrefsChange={() => {}}
            speakerName={() => null}
            tileParked={false}
            awaitingFirstLine={false}
            hasTranscript
            onOpenTranscript={() => {}}
          />
        </div>,
      ),
    );
    const handle = container.querySelector('[aria-label="call.captionsMoveToTop"]') as HTMLElement;
    pointer(handle, "pointerdown", 10);
    expect(stage).not.toHaveBeenCalled();
    // The control is the only thing that opts out: the rest of the stage
    // still gets its pointer events.
    pointer(container.firstElementChild as HTMLElement, "pointerdown", 10);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it("has no move button docked, where there is no edge to move to", () => {
    const el = render({ docked: true });
    expect(el.querySelector('[aria-label="call.captionsMoveToTop"]')).toBeNull();
    expect(el.querySelector('[aria-label="call.captionsMoveToBottom"]')).toBeNull();
  });

  it("below a camera, its ✕ hides the subtitles everywhere, not for materials", () => {
    // Docked because the reader asked for "below", with no worksheet open:
    // "hide with materials" would hide nothing she can see.
    const onPrefsChange = vi.fn();
    const el = render({ docked: true, contentOwnsStage: false, onPrefsChange });
    expect(el.querySelector('[aria-label="call.captionsHideWithContent"]')).toBeNull();
    act(() => (el.querySelector('[aria-label="call.captionsHideMine"]') as HTMLElement).click());
    expect(onPrefsChange).toHaveBeenCalledWith({ visible: false });
  });

  it("below a camera, a standing 'not over materials' choice does not collapse the strip", () => {
    const el = render({
      docked: true,
      contentOwnsStage: false,
      prefs: { ...DEFAULT_CAPTION_PREFERENCES, position: "below", visibleWithContent: false },
    });
    expect(el.querySelector('[role="log"]')).not.toBeNull();
    expect(el.textContent).toContain(bilingual.text);
  });
});

// Measured in a real call: moved to the top, the band's scrim hid the
// "camera and mic are off" message completely. That row is also where the
// audio-blocked and captions-consent prompts appear, both of which need a tap.
describe("at the top, under the call's status messages", () => {
  const top = { ...DEFAULT_CAPTION_PREFERENCES, position: "top" as const };

  it("sits below the messages when there are some", () => {
    const band = render({ prefs: top, topInset: 60 }).firstElementChild as HTMLElement;
    expect(band.style.top).toBe("68px");
  });

  it("takes the edge when there are none", () => {
    const band = render({ prefs: top, topInset: 0 }).firstElementChild as HTMLElement;
    expect(band.style.top).toBe("");
    expect(band.className).toContain("top-3");
  });

  it("ignores the messages at the bottom, which they never reach", () => {
    const band = render({ topInset: 60 }).firstElementChild as HTMLElement;
    expect(band.style.top).toBe("");
    expect(band.className).toContain("bottom-3");
  });
});
