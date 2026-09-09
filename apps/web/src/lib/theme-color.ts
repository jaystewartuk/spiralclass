import { palette, paletteDark } from "@spiralclass/shared";

/**
 * The `theme-color` meta values — the colour a mobile browser paints its own
 * chrome (the address bar on Safari and Chrome) in each scheme.
 *
 * WHY THIS IS ITS OWN MODULE. It is two constants and it could live inline in
 * `app/layout.tsx`, where it did. But it is also the one design value that sat
 * outside every guard the system had — `theme-parity` compares the shared
 * palette against `globals.css`, and this is in neither — so it kept the
 * pre-D-140 brand for as long as nobody looked at a phone: `#FBF7F0` cream in
 * light, and `#B8472E` in dark, which is a PRIMARY colour and never a
 * background, so the page was framed in orange.
 *
 * Pulling it out is what makes it testable. The root layout cannot be imported
 * from a unit test without dragging in `next/font`'s build-time loader, which
 * has no runtime implementation — so a guard that had to import the layout was
 * a guard that would not run.
 */
export const THEME_COLOR = [
  { media: "(prefers-color-scheme: light)", color: palette.background },
  { media: "(prefers-color-scheme: dark)", color: paletteDark.background },
] as const;
