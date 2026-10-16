# Design

How the product looks, where each design value is defined, and what stops it
drifting. The policy is [D-140](../decisions/D-140.md): legibility outranks
visual identity, and the layout asks the pointer, not the width, whether it is
drawn for a finger.

| In this folder                   | What it is for                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `README.md`                      | This page                                                                              |
| `evidence/<label>/manifest.json` | The checksum manifest of one evidence capture (below). The images are not in the tree. |

## Where the design is defined

- **Tokens** — `packages/shared/src/tokens.ts` is the one canonical source:
  the palette and its dark counterpart, spacing, radius, tap targets, motion,
  elevation and the type scale. `apps/web/tailwind.config.ts` exposes them as
  utilities.
- **Theme variables** — an HSL mirror in `apps/web/src/app/globals.css`,
  guarded by `apps/web/src/lib/theme-parity.test.ts`, which converts the HSL
  back to hex and fails on drift from `tokens.ts`.
- **Breakpoints** — `apps/web/src/lib/breakpoints.ts`: Tailwind's default scale
  plus pointer-gated screens for the app shell (D-140), guarded by
  `apps/web/tests/config/responsive-breakpoints.test.ts`.

## What stops drift

- **The token ratchet** — `apps/web/scripts/design-drift.mjs` counts, per file,
  seven kinds of bypass: raw hex colours, literal `rgb()`/`hsl()` colours, raw
  Tailwind palette utilities, arbitrary Tailwind values, raw `<button>`
  elements, ad-hoc scrim opacities, and inline style objects with literal
  values. `apps/web/tests/design-drift.test.ts` holds every file to its entry
  in `apps/web/scripts/design-drift.baseline.json`: a file may not add
  bypasses, and a file migrated to zero cannot regress.

  ```bash
  pnpm --filter spiralclass-web design:drift              # report: totals and worst offenders
  node apps/web/scripts/design-drift.mjs --generate     # rewrite the baseline after migrating a surface
  ```

  A raw palette utility (`bg-emerald-100`) is the bypass that causes a visible
  bug rather than an aesthetic one: it has no `dark:` counterpart, so it renders
  light-on-light in dark mode. Use the `Badge` and `Alert` variants instead.

- **The design-token lint rule** — `apps/web/eslint-rules/design-tokens.mjs`,
  at error on the surfaces listed in `apps/web/eslint.config.mjs` (the `ui/`
  primitives above all, where a raw value would propagate everywhere).
- **Visual regression** — committed `-linux.png` baselines for the portfolio
  surfaces, asserted on every pull request. How they run and how to
  re-baseline them is in [testing.md](../development/testing.md#the-layers).

## Looking at every page

`apps/web/playwright.visual.config.ts` captures every route in
`apps/web/tests/visual/routes.ts` at six viewports (390, 430, 768, 1280, 1440, 1920) in both themes. The route manifest is hand-maintained — a crawl cannot
know that a call page needs a live LiveKit room, or that an invitation link is
consumed by viewing it — and `apps/web/tests/visual/manifest.test.ts` fails
whenever a page route exists on disk without a decision about how it gets
captured.

```bash
pnpm --filter spiralclass-web build && pnpm --filter spiralclass-web start
pnpm --filter spiralclass-web test:visual            # public tier (VISUAL_TIER=public)
VISUAL_TIER=all pnpm --filter spiralclass-web test:visual   # needs DATABASE_URL for the sessions
pnpm --filter spiralclass-web visual:gallery -- --index --label <label>
```

`VISUAL_BASE_URL` picks the server; the config's own header lists its default.

**Capture against a production build, not `next dev`.** `next dev` compiles each
route on first hit, which saturates the single server and times captures out,
and it is not what a user sees. Set `APP_URL` (and `BETTER_AUTH_URL`, if you
set it) to `http://preview.localhost:3000`: `isProductionDeployment()` is true
for any production build whose `APP_URL` lacks `preview`, so a plain local
production build would demand production credentials through
`assertProductionCredentials()`. The authenticated tiers against a local server
also need `E2E_RATE_LIMIT_BYPASS=1` in the server's environment.

`apps/web/scripts/visual-gallery.mjs` turns a capture into:

- `--index` — a contact sheet at `docs/design/gallery/<label>/index.html`,
  every capture of one route side by side across viewports and themes.
  Gitignored build output.
- `--evidence` — the portfolio surfaces, downscaled to JPEG, plus a
  `manifest.json` recording the origin, the commit, the capture time and a
  SHA-256 of every image. Encoding uses macOS `sips`.

> [!WARNING]
> Capture only against a **local, freshly seeded** database. A capture from a
> shared database photographs real people under their real names, and no text
> scanner reads an image. That is why the images under `evidence/` are
> gitignored and only the manifests are committed.
