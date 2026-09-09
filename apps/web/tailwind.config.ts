import type { Config } from "tailwindcss";
// Pull the brand palette + radius + elevation from the shared token source so the
// web's `brand.*` / `rounded-brand-*` / `shadow-brand-*` utilities can't drift
// from mobile. Imported via the source path (not the package barrel) to keep zod
// & friends out of the PostCSS build graph.
import { elevation, palette, radius, typeScale } from "../../packages/shared/src/tokens";
// The responsive screen scale lives in src/lib/breakpoints.ts because
// globals.css and the guard tests read the same numbers — see that file for
// why the scale is shifted off Tailwind's defaults (tablets are touch devices,
// and they are narrow). Imported by source path for the same reason the tokens
// above are: it keeps the PostCSS build graph free of the `@/` alias.
import { CONTAINER_MAX_WIDTH, SCREENS } from "./src/lib/breakpoints";

// Compose the shared elevation geometry into CSS box-shadow strings. The tint is
// the theme-swapping `--shadow-color` var (warm brown in light, black in dark —
// see globals.css) so a single scale renders correctly in both themes. Mobile's
// ThemeProvider.buildElevation reads the same `elevation` numbers, so the two
// platforms' shadows stay in lockstep.
const brandBoxShadow = Object.fromEntries(
  (["sm", "md", "lg"] as const).map((level) => {
    const e = elevation[level];
    return [`brand-${level}`, `0 ${e.y}px ${e.blur}px 0 hsl(var(--shadow-color) / ${e.opacity})`];
  }),
) as Record<`brand-${"sm" | "md" | "lg"}`, string>;

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    // Replaces Tailwind's default scale outright (sm:640 md:768 lg:1024 …), so
    // every tablet width falls through to the unprefixed mobile layout.
    screens: { ...SCREENS },
    container: {
      center: true,
      padding: "1rem",
      // The container plugin reads the VALUES here, not the key names — this
      // says "from 1280px up, settle at 1280px wide". The key is arbitrary
      // and no longer tracks the `2xl` token in `screens` above; it is spelled
      // out rather than derived so the content column keeps its current
      // ceiling no matter where the layout breakpoints move.
      screens: { content: CONTAINER_MAX_WIDTH },
    },
    extend: {
      /**
       * The one canonical social-card shape, 1200x630 (D-123).
       *
       * Named because it is a DOMAIN constant, not a layout choice: the same
       * ratio is baked into SOCIAL_PREVIEW_WIDTH/HEIGHT, into what the Satori
       * route renders, and into every place a teacher previews a card before
       * she posts it. Three call sites were each writing `aspect-[1200/630]`,
       * which is exactly the arbitrary value the token rule exists to catch —
       * and the rule is right: if the four of them ever drifted apart, the
       * preview would stop matching what actually gets shared.
       */
      aspectRatio: {
        social: "1200 / 630",
      },
      colors: {
        /**
         * The video surface is deliberately fixed-dark — it is a stage, not a
         * page, and it does not follow the theme. That is a legitimate
         * exception, but it was being expressed as twenty different
         * white/black opacities invented at each call site: bg-white/15, /20,
         * /25, /30, /50, /70, /90 all appeared, doing about four jobs.
         *
         * Named steps instead. `overlay` lifts a control off the stage;
         * `scrim` darkens what is behind one; `on-dark` is text on either.
         */
        overlay: {
          1: "rgb(255 255 255 / 0.15)",
          2: "rgb(255 255 255 / 0.25)",
          3: "rgb(255 255 255 / 0.5)",
          4: "rgb(255 255 255 / 0.9)",
        },
        scrim: {
          1: "rgb(0 0 0 / 0.4)",
          2: "rgb(0 0 0 / 0.6)",
          3: "rgb(0 0 0 / 0.85)",
        },
        "on-dark": {
          DEFAULT: "rgb(255 255 255 / 1)",
          muted: "rgb(255 255 255 / 0.8)",
          faint: "rgb(255 255 255 / 0.55)",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          // A darker hover, not `primary/90`. An opacity LIGHTENS the ground
          // over a light page, which took on-primary text to 4.41:1.
          hover: "hsl(var(--primary-hover))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          bg: "hsl(var(--danger-bg))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          bg: "hsl(var(--success-bg))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          bg: "hsl(var(--warning-bg))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          bg: "hsl(var(--info-bg))",
          foreground: "hsl(var(--info-foreground))",
        },
        // Earthy chip accents (scheduled / has-materials). Themeable CSS-var
        // tokens so they dark-mode switch like the status colours above.
        clay: { DEFAULT: "hsl(var(--clay))", bg: "hsl(var(--clay-bg))" },
        sage: { DEFAULT: "hsl(var(--sage))", bg: "hsl(var(--sage-bg))" },
        subtle: "hsl(var(--foreground-subtle))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        // The raw shared brand palette (hex), for UI that wants the canonical
        // brand value directly rather than the themeable CSS-variable token.
        brand: palette,
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        // Shared radius scale (mirrors the mobile theme).
        "brand-sm": `${radius.sm}px`,
        "brand-md": `${radius.md}px`,
        "brand-lg": `${radius.lg}px`,
        "brand-xl": `${radius.xl}px`,
      },
      width: {
        // A dialog fills the viewport minus a gutter on each side, so it never
        // touches the edge on a phone. The gutter is the decision; the calc is
        // arithmetic on it.
        "dialog-inset": "calc(100% - 2rem)",
        // The inbox rail beside an open conversation: wide enough that a name
        // and a preview line both survive without truncating to nothing,
        // narrow enough that the thread keeps the room. Only ever shown at
        // `desktop-wide`, where the tablet sidebar has already given its
        // 14rem back.
        rail: "20rem",
      },
      height: {
        // Every chart in the app is this tall. A named height is what makes
        // that a decision rather than a number repeated at each call site.
        chart: "220px",
        // The visual viewport, which excludes a mobile browser's own chrome.
        // `h-screen` (100vh) is taller than the space actually available and
        // pushes controls under the address bar.
        viewport: "100dvh",
        // A full-height conversation: the visual viewport minus the sticky app
        // header (`h-14` in app-nav.tsx and student-nav.tsx). The thread is the
        // one screen whose composer must stay put while only the message list
        // scrolls, so the height is a layout decision rather than a number —
        // it was spelled two different ways, as an inline `calc()` style on the
        // student page and an arbitrary utility on the teacher's.
        //
        // The header's BORDER counts. `h-14` sizes the bar's inner container;
        // the 1px `border-b` sits outside it, so subtracting 3.5rem alone left
        // the page exactly one pixel taller than the viewport — a permanent
        // scrollbar down the one screen that must not scroll, and a composer
        // that could be nudged off the bottom edge.
        thread: "calc(100dvh - 3.5rem - 1px)",
      },
      padding: {
        // Bottom padding for a surface anchored to the bottom edge: the normal
        // gutter, or the home-indicator inset where the device has one.
        "safe-bottom": "max(1.25rem, env(safe-area-inset-bottom))",
      },
      maxWidth: {
        // The two content widths PageShell offers, named because they are
        // design decisions rather than per-screen choices. `reading` is capped
        // by CHARACTERS, not pixels: line length is one of the strongest
        // reported barriers for a dyslexic reader (D-140), and a ch cap holds
        // whatever text size the reader has chosen.
        reading: "66ch",
        content: "1280px",
        // A chat bubble: wide enough for a sentence, narrow enough that the
        // column still reads as a conversation rather than a document. The
        // `ch` cap is the half that matters on a desktop window — 72% of a
        // 48rem column is a 64-character line, which is a paragraph, not a
        // message. Capping by characters (as `reading` does) holds whatever
        // text size the reader has chosen.
        bubble: "min(72%, 56ch)",
        // A photo or video inside a bubble. Wide enough to make out a page of
        // homework, narrow enough that it still reads as a message.
        attachment: "18rem",
        // A drawer or sheet on a phone — leaves a thumb's width of the page
        // behind it so the dismiss target is always reachable.
        sheet: "85vw",
      },
      gridTemplateColumns: {
        /**
         * A money row: who it was, and how much.
         *
         * Named here rather than written as `grid-cols-[minmax(0,1fr)_auto]`
         * at the call site because the two shapes together ARE the responsive
         * decision, and a pair of arbitrary values buried in a className says
         * nothing about the relationship between them.
         *
         * `ledger` is the phone: one flexible column that truncates, and one
         * that sizes to the amount, with the row's second line reusing the
         * same two tracks. `ledger-wide` fans the same four cells out into
         * columns from `lg` — name, detail, status, amount — with the amount
         * given a floor wide enough that the longest formatted total in any
         * supported currency does not wrap, since the whole point of the
         * column is that the figures line up down the page.
         */
        ledger: "minmax(0, 1fr) auto",
        "ledger-wide": "minmax(0, 2fr) minmax(0, 1.6fr) 6rem minmax(9rem, auto)",
      },
      zIndex: {
        // Above Radix, which parks its overlays at 50. Named because "which
        // thing sits on top of the dialog" is a decision about the stack, and
        // z-[60] at a call site says nothing about what it is above.
        "over-overlay": "60",
        "over-everything": "70",
      },
      spacing: {
        // NOT WIRED HERE: the shared `spacing` scale (xs 4, sm 8, md 12, lg 16,
        // xl 24, xxl 32). The design plan called for it alongside `typeScale`,
        // and on inspection it should not be.
        //
        // Tailwind's own spacing scale is already that 4-based ladder — `p-1`
        // IS 4px, `p-3` IS 12px, `p-6` IS 24px. Adding `p-xs`/`p-md` aliases
        // would not replace those, it would sit beside them, and the codebase
        // would then have two spellings for one value with nothing to say which
        // is right. That is precisely the failure the type scale had: a named
        // scale wired in beside the stock one, the app going on using the
        // stock one, and the floor holding only for the steps nobody used.
        //
        // The type scale was worth wiring because the two scales DISAGREED —
        // stock `text-sm` is 14px where the system wanted 15. Spacing does not
        // disagree, so there is nothing to fix and a second name to avoid.
        //
        // The minimum touch target (D-140). It appears as `min-h-target` rather
        // than 2.75rem or h-11 so the rule is legible at the call site: this
        // size is a decision about fingers, not a number someone liked.
        //
        // It is also what let D-141 move the layout breakpoints back to
        // standard values — the touch concern that had been held in the
        // breakpoints lives here instead.
        target: "2.75rem",
        // The bottom padding of a bar stuck to the bottom of the viewport: the
        // normal 12px, unless the device's home indicator needs more. Named,
        // like `target`, because the call site should read as the decision
        // ("clear the home indicator") rather than as a `max()` someone
        // retyped — it was written out longhand in two files, and an arbitrary
        // value is exactly what the design/tokens rule asks us not to spread.
        "safe-bottom": "max(0.75rem, env(safe-area-inset-bottom))",
      },
      fontSize: {
        // The shared type scale, finally reachable from a class name.
        //
        // It has existed in packages/shared since the shared token layer landed and
        // was never wired in, which is the mechanical reason 47 arbitrary sizes grew underneath
        // Tailwind's `text-xs` — including 10px and 9px, which no part of the
        // system ever sanctioned. A scale nobody can reach is a scale nobody
        // uses.
        ...Object.fromEntries(
          Object.entries(typeScale).map(([name, step]) => [
            name,
            [`${step.fontSize / 16}rem`, { lineHeight: `${step.lineHeight / 16}rem` }],
          ]),
        ),

        // Tailwind's OWN scale, redefined onto D-140's floors.
        //
        // Wiring the named scale in was necessary and not sufficient: it added
        // a second scale beside Tailwind's rather than replacing it, and the
        // app kept using Tailwind's — `text-sm` 802 times and `text-xs` 499.
        // At stock values that is 14px and 12px, both under the 15px floor
        // D-140 states for supporting text, so the floor was true only of the
        // steps almost nothing used.
        //
        // Redefining the keys rather than deleting them is deliberate. Deleting
        // them would make 1,301 class names silently emit nothing — Tailwind
        // does not error on a class it cannot resolve, so the failure would be
        // invisible until someone looked at a screen. Redefining moves every
        // one of those call sites onto the scale without touching them.
        //
        // Nothing here shrinks; every value is the same or larger. The cost is
        // the one D-140 already accepted: less fits on a screen.
        xs: ["0.9375rem", { lineHeight: "1.4375rem" }], // 15 — the floor
        sm: ["0.9375rem", { lineHeight: "1.4375rem" }], // 15 — same, honestly
        base: ["1.0625rem", { lineHeight: "1.75rem" }], // 17 — body
        lg: ["1.1875rem", { lineHeight: "1.5625rem" }], // 19 — h3
        xl: ["1.25rem", { lineHeight: "1.75rem" }], // 20
        "2xl": ["1.375rem", { lineHeight: "1.6875rem" }], // 22 — h2
        "3xl": ["1.875rem", { lineHeight: "2.125rem" }], // 30 — h1
      },
      minWidth: {
        // The width below which a wide table stops being readable and starts
        // scrolling instead. Shared by the privacy-notice tables and the
        // calendar's time grid, which is why it is a name rather than three
        // copies of a number.
        table: "36rem",
        // The floor under a chat attachment's own chrome: below this a voice
        // note's scrubber has no room to be dragged and a file chip's name is
        // all ellipsis. Paired with `maxWidth.attachment`, which caps the
        // other end.
        attachment: "12rem",
      },
      minHeight: {
        // A month-grid day cell. Two numbers rather than one because the cell
        // holds different things at each size, and both are derived from the
        // type scale rather than eyeballed: on a phone it carries the date and
        // a row of density dots (`cell`), from `sm` up it carries the date plus
        // two 15px event chips and a "+n more" line, which is the smallest
        // height that fits them without clipping (`cell-lg`). 15px is the floor
        // D-140 puts under supporting text, so the cell has to grow to the type
        // rather than the type shrinking to the cell — which is what the old
        // 4.5rem/6rem pair assumed, back when these chips were rendering at a
        // `text-label` step that no longer exists.
        cell: "5rem",
        "cell-lg": "7.5rem",
      },
      maxHeight: {
        // A sticky contents rail beside a long article: the viewport minus the
        // offset it sticks at, plus a gutter. Named because the alternative is
        // an arbitrary calc at the call site that says nothing about why — and
        // a rail without this simply loses its last entries off the bottom of
        // the screen, with no scrollbar and no hint that anything is missing.
        rail: "calc(100dvh - 6rem)",
        // How tall a modal surface may grow before its own body scrolls. The
        // sliver left over is what tells the reader there is a page behind it,
        // so it is a design decision rather than "as tall as it fits".
        // `dvh` on the phone form for the same reason `h-viewport` uses it —
        // 100vh sits under the browser's address bar.
        sheet: "92dvh",
        "sheet-desktop": "85vh",
        // A header dropdown (the avatar menu, the nav group menus). It hangs
        // off a sticky 3.5rem bar, so it is capped at the viewport under that
        // bar plus a gutter — a settings menu with a dozen destinations then
        // scrolls inside itself instead of running off the bottom of a laptop
        // screen. `dvh`, not `vh`, for the same reason `h-viewport` is: the
        // browser's own chrome is not usable space.
        menu: "calc(100dvh - 5rem)",
        // A photo or video message. Tall enough for a portrait photo, short
        // enough that one attachment cannot fill the whole thread.
        attachment: "20rem",
        // A panel docked over the video stage: never more than two-thirds, so
        // the person you are talking to is always visible.
        "over-stage": "70%",
        // A popover that opens UPWARD out of the call's bottom chrome (the
        // subtitle settings). Its anchor already sits low on the stage, and
        // the stage clips its own overflow, so on a short window an
        // unconstrained popover simply loses its top half — legend, options
        // and all — with no scrollbar and no hint that anything is missing.
        //
        // A VIEWPORT unit, not a percentage: the containing block here is the
        // 32px-tall control cluster the popover hangs off, so a percentage
        // would resolve against that and mean nothing. 50vh clears the band's
        // deepest bottom offset (a parked camera tile, ~182px) on every
        // window height this app is used at.
        "over-controls": "50vh",
      },
      ringWidth: {
        // D-140 asks for 3px focus rings. Tailwind ships 0/1/2/4/8, so
        // there was no way to write the rule and every primitive used `ring-2`
        // instead — the decision was unreachable rather than ignored, the same
        // shape as the type scale that was never wired in.
        3: "3px",
      },
      letterSpacing: {
        // The wordmark's tracking is a brand constant, not a per-component
        // choice, so it gets a name. Between Tailwind's `normal` and `tight`:
        // enough to close the word up, not so much that the open letterforms
        // D-140 selected for start to collide.
        wordmark: "-0.01em",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Verdana", "Tahoma", "ui-sans-serif", "sans-serif"],
        // Kept as a name so `font-display` call sites keep compiling, but it
        // resolves to the same face as everything else: D-140 removed the
        // second typeface rather than swapping it.
        display: ["var(--font-sans)", "Verdana", "Tahoma", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      // Warm, theme-aware elevation scale derived from the shared `elevation`
      // tokens. Extends (doesn't replace) Tailwind's default shadow scale, so
      // `shadow-sm`/`shadow-md` still work while `shadow-brand-*` carry the tint.
      boxShadow: brandBoxShadow,
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
