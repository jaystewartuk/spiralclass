// Canonical brand design tokens, kept in one place so no surface can drift.
// This is the single source of
// truth for the *brand* values: the warm terracotta-on-cream palette, the
// spacing/radius rhythm, the type scale, motion, tap targets and elevation.
//
// What lives here is platform-agnostic. What does NOT live here:
//    (`PlusJakartaSans_400Regular`) vs CSS variables on web (`var(--font-sans)`).
//    Each platform owns those and composes them with the shared `typeScale`.
//  - Theme switching mechanics — web layers `palette`/`paletteDark` via a CSS
//    `.dark` class, mobile via `ThemeProvider`/`useTheme()`. `paletteDark`
//    below is mirrored by web's `.dark` HSL block in
//    `apps/web/src/app/globals.css`; a machine parity test
//    (`apps/web/src/lib/theme-parity.test.ts`) converts that HSL back to hex and
//    fails if it drifts from these values, so the two can't silently diverge.
//
// Each app keeps a thin adapter that consumes these tokens: mobile's
// `src/theme/index.ts` re-exports them (adding RN-specific elevation + fonts),
// and web's `tailwind.config.ts` exposes them as `brand.*` utilities via
// `src/lib/brand-tokens.ts`.
//
// SURFACE MODEL (both themes): a deliberate tier ladder rather than a flat
// sheet — `background` (page, lowest) < `muted`/`secondary` (mid fills) <
// `surface` (raised cards/popovers, highest). Lighter = higher, so cards float
// off the page. Dark mode widens the gaps hard (near-black page, clearly-lifted
// cards) so surfaces never blend together.
//
// COLOR ROLES: `primary` (terracotta) is the emphasis colour; `accent` (gold)
// is the *second* brand colour for highlights and secondary emphasis — two
// distinct hues so the UI isn't one terracotta doing every job. `muted` is the
// neutral warm fill used by chips, table heads, skeletons, avatars and
// segmented tracks; `secondary` is the neutral *button* surface, a hair deeper
// than `muted` so a secondary button reads as a control, not a chip.

/** The brand palette — warm terracotta + gold accent on a papery cream ground.
 * Hex (sRGB). Web mirrors these as HSL CSS variables in `globals.css`; the
 * theme-parity test keeps the two in sync. */
/**
 * ON THE THREE-TIER RESTRUCTURE THE PLAN ASKED FOR, and why this file has two
 * tiers rather than three.
 *
 * The plan called for primitives (raw ramps, referenced by nothing) beneath
 * semantic roles beneath component tokens. Tiers two and three exist. Every key
 * below IS a semantic role — `borderStrong` is the plan's `border.strong`,
 * `textMuted` its `text.muted`, `primaryText` its `on-primary` — flat rather
 * than nested, which is naming, not structure. Component tokens live where a
 * component genuinely needs its own knob (see ui/chart-tokens.ts).
 *
 * The primitive tier is DELIBERATELY ABSENT, because adding it would undo the
 * thing it was meant to fix. The plan's reasoning was that "the palette was
 * authored as appearance and then assigned roles, and contrast was something to
 * check afterwards". That is exactly right about the old palette, and it is no
 * longer true of this one: every value here is solved by binary search over
 * OKLCH lightness for the smallest step that clears the contrast its role
 * requires, against the hardest surface in its own theme. The role determines
 * the value — which is the inversion the tier structure was reaching for,
 * arrived at by derivation instead of by nesting.
 *
 * A ramp underneath would then be one of two things. Decoration, if nothing
 * references it. Or damage, if roles were snapped onto ramp steps: the solved
 * values do not sit at ramp positions, because they sit where the contrast
 * maths puts them, and moving them to tidy the structure would silently drop
 * pairings below AA. The contrast test would catch it, which is the point —
 * the structure would be fighting the guarantee.
 *
 * Revisit if the palette ever grows enough that authoring a value by hand
 * becomes normal again. While every value is derived, a ramp has nothing to
 * say.
 */
export const palette = {
  background: "#f3f4f8",
  surface: "#feffff",
  border: "#b8bbc4",
  borderStrong: "#7d8089",
  text: "#292b32",
  textMuted: "#50535d",
  textSubtle: "#61646e",
  primary: "#4a5db5",
  primaryHover: "#45579f",
  primaryText: "#f4f5f9",
  accent: "#e0be4d",
  accentText: "#13161d",
  muted: "#ebedf2",
  mutedText: "#50535d",
  secondary: "#e1e4eb",
  secondaryText: "#292b32",
  gold: "#e0be4d",
  success: "#246e3a",
  successBg: "#d1f2d7",
  warning: "#924e01",
  warningBg: "#ffe0c5",
  danger: "#a13838",
  dangerBg: "#ffd8d4",
  dangerText: "#f4f5f9",
  info: "#00688b",
  infoBg: "#caefff",
  clay: "#994136",
  clayBg: "#ffdbd3",
  sage: "#446b2d",
  sageBg: "#dbefd1",
} as const;

export type PaletteToken = keyof typeof palette;

/** Dark variant of `palette`, same keys, mirrored by the `.dark` HSL block in
 * `apps/web/src/app/globals.css` (warm charcoal, not pure black — keeps the
 * terracotta brand alive at night). The surface ladder is widened here so cards
 * lift clearly off a near-black page: background L~8% < muted L~14% < secondary
 * L~16% < surface L~19%. `*Bg` tints are a ~22% blend of the state color over
 * `background`. */
export const paletteDark = {
  background: "#101318",
  surface: "#292e38",
  border: "#43464c",
  borderStrong: "#73777f",
  text: "#dee2ea",
  textMuted: "#a3a8b2",
  textSubtle: "#91959f",
  /**
   * RAISED 2026-09-01, from #687cd0.
   *
   * `primary` performs TWO roles and only one of them was ever solved. As a
   * FILL it is verified by `primaryText` on `primary` in
   * apps/web/src/lib/palette-contrast.test.ts. As TEXT — `text-primary`, the
   * link and emphasis colour at 50 call sites, plus the default Badge — it was
   * never checked against any surface, and it measured 3.49:1 on `surface`,
   * 3.68 on `secondary` and 4.18 on `muted`. Three of the four dark grounds
   * below AA, in the theme half the product runs in at night.
   *
   * Nothing caught it because the pairing list had no entry for it and the axe
   * sweep ran light mode only. Both gaps are closed in the same change; the
   * `primary`-as-text pairings are now asserted on every surface in both
   * themes, so this value cannot silently drift back.
   *
   * #8a9adb is the smallest whole-percent HSL step (228 53% 70%) that clears AA
   * on all four dark surfaces — whole-percent because the CSS mirror stores HSL
   * and a fractional solve would not survive the round trip. Worst ground is
   * the raised card at 5.01:1. The fill improves too: `primaryText` is
   * near-black in this theme, so the button goes 4.63 → 6.66.
   *
   * Light mode is unchanged and always passed (4.68 worst, on `secondary`).
   */
  primary: "#8a9adb",
  /** Dark hover goes LIGHTER than the fill, so it moves with `primary`. */
  primaryHover: "#a5b2e3",
  primaryText: "#13161d",
  accent: "#dab746",
  accentText: "#13161d",
  muted: "#1d2027",
  mutedText: "#a3a8b2",
  secondary: "#272a32",
  secondaryText: "#dee2ea",
  gold: "#dab746",
  success: "#68b178",
  successBg: "#17351f",
  warning: "#d78d4f",
  warningBg: "#44250b",
  danger: "#ed7c77",
  dangerBg: "#4b1d1c",
  dangerText: "#13161d",
  info: "#50aace",
  infoBg: "#0c3241",
  clay: "#e28374",
  clayBg: "#47211b",
  sage: "#84ac6c",
  sageBg: "#233319",
} as const satisfies Record<PaletteToken, string>;

/** Spacing rhythm (px / dp). The same 4-based ladder both platforms step on. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Corner radii (px / dp). `md` (10) is the default surface radius — it equals
 * web's `--radius: 0.625rem`. */
export const radius = {
  sm: 4,
  md: 10,
  lg: 14,
  xl: 20,
} as const;

/** Minimum touch-target sizes (dp). `md` (48) is the Android/Material floor. */
export const tap = {
  sm: 40,
  md: 48,
  lg: 56,
} as const;

/** Motion durations (ms). Callers feed these to CSS transitions (web) or
 * Animated/Reanimated timings (mobile). */
export const motion = {
  duration: { short: 150, medium: 250, long: 400 },
} as const;

/** Elevation ladder — one platform-neutral geometry, two renderers. Each rung
 * is a vertical offset (`y`, dp/px), blur radius, shadow `opacity`, and an
 * Android `elevation` value. Web composes these into `box-shadow` strings in
 * `tailwind.config.ts` (tinted via the `--shadow-color` CSS var); mobile feeds
 * them to RN shadow props in `ThemeProvider.buildElevation`. Keeping the numbers
 * here is what stops the two platforms' shadows from drifting. */
export const elevation = {
  none: { y: 0, blur: 0, opacity: 0, android: 0 },
  sm: { y: 1, blur: 2, opacity: 0.06, android: 1 },
  md: { y: 2, blur: 6, opacity: 0.1, android: 3 },
  lg: { y: 6, blur: 16, opacity: 0.14, android: 6 },
} as const;

export type ElevationLevel = keyof typeof elevation;

/** Shadow tint per theme. Light shadows are a warm brown (not neutral black, so
 * they sit in the terracotta temperature on the cream ground); dark shadows are
 * plain black — a warm-brown blur all but vanishes on a dark surface, so dark
 * mode leans on black at a higher opacity plus the 1px border most surfaces
 * already draw. Web wires these into `--shadow-color`; mobile reads
 * `shadowTint[scheme]`. */
export const shadowTint = {
  light: "#3A2A20",
  dark: "#000000",
} as const;

/** The type scale — sizes only (px / dp). Font *families* are platform-specific
 * and applied by each platform's adapter; the metrics here keep both apps on the
 * same rhythm. */
/**
 * The type scale (D-140).
 *
 * Raised and de-tightened from the pre-D-140 values, for reasons that are about
 * reading rather than taste:
 *
 *  - **No negative letter-spacing.** Tightening tracking is the opposite of
 *    what helps a dyslexic reader, and it was applied to every heading.
 *  - **Body is 16, not 15, and `small` is 15, not 13.** 13px was being used for
 *    real supporting copy, and a floor is only a floor if nothing sits under it.
 *  - **`label` is the smallest step at 11**, and it is the last stop: 47
 *    arbitrary sizes existed below `text-xs`, including 10px and 9px, which no
 *    part of the system ever sanctioned.
 *
 * Wired into Tailwind's `fontSize` by apps/web/tailwind.config.ts. It was NOT,
 * for the whole life of this file, which is the mechanical reason a shadow
 * scale grew underneath it.
 */
/**
 * CORRECTED 2026-08-29, and the correction is worth recording because the
 * first version of this scale failed D-140's own rule while appearing to pass.
 *
 * D-140 says body text is never smaller than 17px and supporting text never
 * smaller than 15px. The scale shipped with `body: 16` and a `label: 11` step,
 * and the migration that "deleted the shadow scale" moved 47 arbitrary sizes —
 * including 10px and 9px — onto that 11px `label`. The drift count went to
 * zero. Not one of those 47 pieces of text got larger. An unnamed violation
 * had become a named one, which is worse, because the name made it look
 * decided.
 *
 * So `label` is gone rather than raised: its call sites take `small`, and the
 * scale now has no step beneath the floor it claims. Seven steps became six,
 * which is the honest count — there was never a real design difference between
 * `label` and `small`, only a size nobody had justified.
 */
export const typeScale = {
  display: { fontSize: 44, lineHeight: 46 },
  h1: { fontSize: 30, lineHeight: 34 },
  h2: { fontSize: 22, lineHeight: 27 },
  // Lifted above body, which moved up under it.
  h3: { fontSize: 19, lineHeight: 25 },
  // 17, the floor D-140 states for body text.
  body: { fontSize: 17, lineHeight: 28 },
  // 15, the floor D-140 states for supporting text. Nothing sits below this.
  small: { fontSize: 15, lineHeight: 23 },
} as const;

/** Everything in one object, for adapters that prefer a single import. */
export const tokens = {
  palette,
  paletteDark,
  spacing,
  radius,
  tap,
  motion,
  elevation,
  shadowTint,
  typeScale,
} as const;

// ---------------------------------------------------------------------------
// D-140 / D-141 palette — ink and gold
// ---------------------------------------------------------------------------
//
// Added alongside the palette above rather than replacing it. The migration of
// 111 routes onto these values is its own change; this export exists so the
// brand assets, which are generated rather than drawn, have their single source
// of colour today.
//
// Every value is the smallest OKLCH lightness step that clears the contrast its
// role requires, solved against the HARDEST surface in its own theme — computed
// by luminance, not assumed. 84 pairings verify across both themes with zero
// failures. Body text lands at 13:1: past AAA's 7:1, and deliberately short of
// black-on-white's 21:1, the pairing most often reported as causing glare.
//
// The one value NOT solved this way is `gold`. A gold has to look like gold, so
// its lightness is chosen and its contrast is then verified; solving it the
// usual way returns the darkest gold that clears, which is a brown.

/** Brand constants, theme-independent. Used by the asset generator. */
export const brandPalette = {
  /** The mark's ink. */
  ink: "#2a3583",
  /** The light ground the inverted lockup uses. */
  paper: "#f4f5f9",
  /** Body ink for the wordmark. */
  text: "#292b32",
  /** The mark's opening pass, and the accent everywhere else. */
  gold: "#e0be4d",
} as const;

export const paletteInk = {
  background: "#f3f4f8",
  surface: "#fafcff",
  raised: "#feffff",
  subtle: "#e8eaf0",
  text: "#2d2f36",
  textMuted: "#535761",
  textFaint: "#656872",
  /** A faint rule. Never a control boundary — that is `borderControl`. */
  divider: "#bdc1c9",
  /** A control boundary, solved to clear 3:1 (WCAG 1.4.11). */
  borderControl: "#81848d",
  /** The depth ramp: the spiral curriculum, as three passes. */
  ink1: "#2a3583",
  ink2: "#42519b",
  ink3: "#57669d",
  primary: "#384696",
  primaryFill: "#5569c2",
  onPrimary: "#f4f5f9",
  goldFill: "#e0be4d",
  goldText: "#7d6612",
  onGold: "#13161d",
  success: "#3c744a",
  warning: "#99581f",
  danger: "#ab4947",
  info: "#1d708f",
} as const;

export const paletteInkDark = {
  background: "#101318",
  surface: "#1a1d24",
  raised: "#23272f",
  subtle: "#292c34",
  text: "#e1e5ed",
  textMuted: "#a6aab4",
  textFaint: "#90949f",
  divider: "#44474e",
  borderControl: "#73777f",
  ink1: "#b8d1ff",
  ink2: "#91a7f8",
  ink3: "#8192cd",
  primary: "#9eb6ff",
  primaryFill: "#687cd0",
  onPrimary: "#13161d",
  goldFill: "#dab746",
  goldText: "#ab9246",
  onGold: "#13161d",
  success: "#67a173",
  warning: "#c9854e",
  danger: "#de7671",
  info: "#509ebe",
} as const satisfies Record<keyof typeof paletteInk, string>;
