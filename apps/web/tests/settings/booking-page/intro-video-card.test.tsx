import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// Public-page intro video card (D-73 fix): previously the <video poster> was
// the teacher's profile photo, which duplicated the same headshot twice on
// the page. Regression coverage for "a teacher's profile picture must never
// be used as the introduction video thumbnail" — this component takes no
// photo prop at all, so there is structurally nothing it could render as a
// photo-based poster.

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("posthog-js/react", () => ({ usePostHog: () => null }));

const { IntroVideoCard } = await import("@/app/b/[slug]/intro-video-card");

const PHOTO_URL = "https://r2.example.com/teacher-photos/t1.jpg";
const VIDEO_URL = "https://r2.example.com/teacher-videos/t1.webm";

const PROPS = {
  videoUrl: VIDEO_URL,
  teacherName: "Mira",
  teacherId: "teacher-1",
  slug: "alicia-moreno",
};

const render = () => renderToStaticMarkup(React.createElement(IntroVideoCard, PROPS));

describe("IntroVideoCard", () => {
  it("never renders the teacher's profile photo as the video's poster", () => {
    const html = render();
    // No poster attribute at all (the bug: poster={photoUrl}) — and since the
    // component's props don't even accept a photo URL, there is nothing that
    // could leak the profile photo in here even if one were passed by a caller.
    expect(html).not.toContain("poster=");
    expect(html).not.toContain(PHOTO_URL);
  });

  it("renders the video element with the given source", () => {
    const html = render();
    expect(html).toContain(`src="${VIDEO_URL}`);
    expect(html).toContain("<video");
  });

  it("asks for a first frame rather than black, via a media fragment", () => {
    // `#t=0.1` decides WHICH frame is painted. It does not decide whether one
    // is painted at all — a seek cannot render media that was never fetched,
    // and asserting this attribute alone is what let a broken card ship: the
    // attribute was present and production still sat at readyState 0.
    // The fetch half is the preload upgrade, covered below.
    expect(render()).toContain(`src="${VIDEO_URL}#t=0.1"`);
  });

  it("never preloads on first paint, whatever the upgrade does later", () => {
    // A visitor who never scrolls to the card must pay nothing for it. This
    // half of the old guard is unchanged and is not negotiable.
    const html = render();
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain('preload="auto"');
  });

  it("only ever upgrades preload behind an abort", () => {
    // THIS GUARD CHANGED ON 2026-08-31, and the history matters because the
    // upgrade has now been shipped twice.
    //
    // It was "never preloads the whole video, at ANY point", added when the
    // upgrade was reverted on 2026-08-30. Its stated reason was a measurement:
    // the live intro video was a 42 MB MP4 with `moov` at the END (`ftyp`
    // straight into `mdat`), so no frame was decodable until the whole file
    // arrived — "auto" bought 42 MB and still painted a rectangle.
    //
    // Re-measured on 2026-08-31 against the same production URL: the file is
    // 6.3 MB, and its first bytes are `ftyp` then `moov` at offset 32. It is
    // faststart. Both halves of the original premise are gone, because the
    // teacher re-uploaded. Real Chrome with "metadata" still paints nothing
    // after eight seconds on a fresh load, so the card is showing a blank
    // rectangle on the acquisition page for no remaining reason.
    //
    // What has NOT changed is the hazard: nothing validates faststart at
    // upload and MAX_VIDEO_BYTES is 50 MB, so the next upload can recreate the
    // bad file exactly. So the guard is not deleted — it is narrowed from "no
    // upgrade" to "no UNBOUNDED upgrade". If a future edit reintroduces a bare
    // `preload = "auto"` with nothing to call it off, this fails, which is the
    // regression the 2026-08-30 revert was actually protecting against.
    const src = readFileSync(
      join(process.cwd(), "src", "app", "b", "[slug]", "intro-video-card.tsx"),
      "utf8",
    );

    if (!/\.preload\s*=\s*["']auto["']/.test(src)) return; // no upgrade at all is still fine

    // The abort: a timer, a readyState check that proves a frame arrived, and
    // a path back to not downloading.
    expect(src, "an upgrade must be bounded by a timeout").toMatch(/setTimeout/);
    expect(src, "the abort must test for a decoded frame, not assume one").toMatch(/readyState/);
    expect(src, "the abort must actually stop the fetch").toMatch(/\.preload\s*=\s*["']none["']/);
    // And it must not fire for someone who asked us to save their data.
    expect(src, "Save-Data / 2g visitors must be excluded").toMatch(/saveData/);
  });

  it("keeps the overlay OPAQUE until a frame is actually decoded", () => {
    // First paint has no decoded frame, so a translucent scrim would sit over
    // an empty black element and read as washed out — which is what shipped
    // on 2026-08-30 and had to be corrected. Translucency is earned by
    // `loadeddata`, not assumed.
    const html = render();
    expect(html).toContain("from-primary to-primary/70");
    expect(html).not.toContain("from-primary/85");
  });

  it("does not render native controls before playback starts", () => {
    // They drew a second control bar underneath the overlay's own play
    // button: two competing affordances for one action.
    expect(render()).not.toContain("controls");
  });

  it("shows a branded play affordance before playback starts", () => {
    const html = render();
    expect(html).toContain("bookingPage.watchIntro");
    expect(html).toContain("<button");
  });

  it("labels the video for screen readers with the teacher's name", () => {
    const html = render();
    expect(html).toContain("Mira");
    expect(html).toMatch(/aria-label="[^"]*Mira[^"]*"/);
  });

  // A landscape clip uploaded from the gallery used to be centre-cropped to a
  // vertical slice of the 9:16 frame (object-cover), routinely cutting the
  // teacher's head off — while mobile's expo-video letterboxed the same file
  // (contentFit="contain"). The two platforms must agree.
  it("letterboxes rather than crops, matching the mobile player", () => {
    const html = render();
    expect(html).toContain("object-contain");
    expect(html).not.toContain("object-cover");
  });

  // preload="none" left `duration` NaN, so the quartile progress milestones
  // could not be computed until playback was already under way — and made the
  // first tap pay a full round-trip before anything moved.
  it("preloads metadata so the first tap is responsive and duration is known", () => {
    expect(render()).toContain('preload="metadata"');
  });

  it("renders without a PostHog client present (ad-blocked visitor)", () => {
    // usePostHog() returns null above; every capture call site is optional-chained,
    // so an ad-blocked or not-yet-initialised SDK must not break the booking page.
    expect(() => render()).not.toThrow();
  });
});
