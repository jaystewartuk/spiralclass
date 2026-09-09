# Design

How the product looks, why, and what stops it drifting.

This directory did not exist before 2026-08-29. Design decisions lived in
decision records (web–mobile token parity, and
[D-122](../decisions/D-122.md) on breakpoints) and in unusually long header
comments on `packages/shared/src/tokens.ts` and `apps/web/src/lib/breakpoints.ts`.
That was enough while the only reader was the person who wrote it.

## The state of things, measured 2026-08-29

The **definition** layer is disciplined and should be left alone until the
re-art-direction changes its values:

- One canonical hex source, `packages/shared/src/tokens.ts` — 33 palette keys,
  a full dark counterpart, spacing, radius, tap targets, motion, elevation and
  a type scale.
- An HSL mirror in `apps/web/src/app/globals.css`, guarded by
  `apps/web/src/lib/theme-parity.test.ts`, which converts HSL back to hex and
  fails on drift.
- A custom breakpoint scale in `apps/web/src/lib/breakpoints.ts`, guarded by
  `apps/web/tests/config/responsive-breakpoints.test.ts`.

The **consumption** layer leaks. `pnpm design:drift` counts it:

|                                          |                          |
| ---------------------------------------- | ------------------------ |
| raw hex colours                          | 10                       |
| literal `rgb()`/`hsl()` colours          | 9                        |
| raw Tailwind palette utilities           | 107                      |
| arbitrary Tailwind values                | 136                      |
| raw `<button>` elements                  | 113                      |
| ad-hoc white/black scrim opacities       | 51                       |
| inline style objects with literal values | 15                       |
| **total**                                | **441 across 102 files** |

**The 107 raw palette utilities are the ones that cause a visible bug rather
than an aesthetic one.** `bg-emerald-100 text-emerald-900` and its relatives
carry no `dark:` counterpart, so every one of them renders light-on-light in
dark mode. Most are hand-rolled pills and alerts that duplicate `Badge` and
`Alert` variants which already exist and are unused.

Three token surfaces are defined and consumed by nothing: `brand.*` colours,
`rounded-brand-*`, and the shared `typeScale` and `spacing` objects, neither of
which was ever wired into `tailwind.config.ts`. That last omission is the
mechanical cause of the 48 arbitrary font sizes below `text-xs` and of three
competing card paddings.

## The two instruments

**`pnpm design:drift`** — `apps/web/scripts/design-drift.mjs`. Counts the seven
categories above, per file. `--generate` writes the ratchet baseline;
`tests/design-drift.test.ts` enforces it, so a file may not add bypasses beyond
its baseline and a migrated file cannot regress. Same shape as the i18n ratchet
next to it, for the same reason: a hard ban on 441 existing bypasses would mean
one un-reviewable commit, but net-new drift can and should fail today.

**`pnpm test:visual`** — `apps/web/playwright.visual.config.ts`. Captures every
route in `apps/web/tests/visual/routes.ts` at six viewports in both themes. The
viewports are chosen against `breakpoints.ts`, not Tailwind's defaults: 390 and
430 for phones, **768 because D-122 deliberately gives every tablet the phone
layout**, 1280 because it is one pixel below `DESKTOP_MIN_WIDTH`, 1440 as the
`lg` layout, and 1920 because nothing currently responds to it.

The manifest is hand-maintained — a crawl cannot know that
`/dashboard/classes/[bookingId]/call` needs a live LiveKit room, or that
`/i/[token]` is consumed by viewing it. `tests/visual/manifest.test.ts` keeps
it honest by failing whenever a route exists on disk without a decision about
how it gets captured. Today: 111 routes, 99 capturable, 12 excluded with a
stated reason.

**Capture against a production build, not `next dev`.** Two reasons, and the
second matters more. `next dev` compiles each route on first hit, which
saturates the single server process and produced 69 failures — 45-second
navigation timeouts, dropped connections, contexts destroyed mid-settle — at
about 12 captures a minute. The production build does 87 a minute with none.
And a dev build is not what a user sees: unminified, dev overlays, no route
caching. A baseline whose purpose is a before-and-after should photograph the
real thing.

Set `APP_URL` and `BETTER_AUTH_URL` to `http://preview.localhost:3000` while
doing it. `isProductionDeployment()` is `NODE_ENV === "production" && !APP_URL
.includes("preview")`, so a plain local production build reads as _the
production deploy_ — which trips `assertProductionCredentials()` and demands
Sentry, PostHog, Inngest and email credentials, and closes the test seams.
The preview-shaped host gives a production **build** that is not the production
**deploy**, and it resolves to ::1.

```
pnpm --filter spiralclass-web build && pnpm --filter spiralclass-web start
pnpm test:visual                                  # public tier, against preview
VISUAL_BASE_URL=https://spiralclass.com pnpm test:visual
VISUAL_TIER=all pnpm test:visual                  # needs DATABASE_URL
pnpm visual:gallery                               # contact sheet + evidence set
```

## What is committed, and what is not

The full sweep is roughly 1,200 PNGs and 600 MB — about twenty times this
repository's entire history. It is build output and it is gitignored.

What survives is [`evidence/`](evidence/): three `manifest.json` files, one per
capture run, recording the origin, the commit, the capture time and a SHA-256
of every image the run produced. **The images themselves are not published.**

⚠️ **They rendered a real account.** The captures were taken against a seeded
database carrying a real teacher's own profile — the name in every page
heading, the booking slug, the prices and the bio, all in frame. A text pass
over the tree cannot see any of that — **a JPEG is not text and no scanner
reads one** — which is exactly why it outlived a sweep that cleared the same
details from every file that held them. The whole set is gitignored rather than
retaken, because retaking it needs the seeded Neon branch and a local server,
and the comparison it supports is worth less than the exposure.

**The manifests stay, and they are most of the value.** They record what was
captured, from where, at which commit, and the hash of each image, so the
before-and-after remains checkable by anyone holding the files — it just is not
this repository that hands them over.

`evidence/before/` was captured against **production** on 2026-08-29, before
any token moved. It cannot be retaken, and it is not here for the same reason.

## The capture database

The authenticated tiers need a session, so they are captured against a local
dev server pointed at a **dedicated Neon branch**:

- The preview project (`agendaprofe-preview`; `NEON_PROJECT_ID`, from
  `neonctl projects list`), branch **`design-baseline`**.
- Created 2026-08-29 off preview's default branch, then reset and seeded clean.
- Credentials live in `apps/web/.env.local`, which is gitignored. Recreate with
  `neonctl branches create --project-id "$NEON_PROJECT_ID" --name design-baseline`,
  then `prisma migrate deploy` and `pnpm seed`.

**This branch is kept deliberately, not left behind** (the operator, 2026-08-29). The
"after" capture has to run against the same data as the "before" or every seed
difference shows up as a design change, and a before-and-after that cannot
distinguish the two proves nothing. Deleting it would silently cost the
comparison the whole redesign is measured by.

It costs Neon storage for as long as it exists. Delete it once the after-capture
is taken and the comparison is published:
`neonctl branches delete design-baseline --project-id "$NEON_PROJECT_ID"`.

Note for whoever re-seeds it: `pnpm seed` is **not** idempotent against a
database that already holds seeded packages — the student cleanup hits
`packages_student_id_fkey`'s RESTRICT. Reset first.

**There are two "before" captures, and the difference matters.** The committed
evidence set is production — the real thing a stranger reached on 2026-08-29,
and the only honest record of it. The full gallery is captured against a local
dev server on a seeded database, because 86 of the 99 routes need a session and
production is not a place to hold one. The _comparison_ set has to be the local
one: an "after" taken locally and diffed against a production "before" would
attribute every seed-data difference to the redesign. So production is the
record, local is the ruler, and neither substitutes for the other.

## What the baseline shows

Findings from the first sweep, all visible in the contact sheet and all
verified against the live site:

- **The CTA band and the primary button invert in dark mode.** Light text on
  clay in light mode, dark text on the same clay in dark. There is no
  `on-primary` token, so both read `--foreground`, which is theme-dependent
  while the background is not.
- **Container widths disagree within a single page.** On the landing page at
  1440, the AI demo sits in about 570px and the feature grid in about 1000px.
  Ten different page-shell widths are in use across the app with no `PageShell`
  primitive.
- **Seven feature cards in a three-column grid** leave an orphan, and card
  heights are unequal.
- **At 768 the header renders its desktop navigation while the body keeps the
  phone layout.** This is D-122 working as designed, and it is also the first
  thing a reviewer resizing a window will notice.
- **The wordmark is inconsistent** — lowercase `spiralclass` in the header,
  `SpiralClass` in the footer and in all copy.
- **`logo-horizontal.svg` and `logo-stacked.svg` hardcode `fill="#1F1410"`**, so
  the wordmark disappears on a dark background. The React `Logo` component is
  theme-reactive; the static SVGs are an independent copy of the same geometry.
- **The logo mark's path data exists in 16 places** — six SVG assets, four
  Satori renderers, the React component, the email shell, and a separately
  rescaled rewrite in `icon.svg`. There is no single source for the geometry.
- **Five brand hexes are not token values**: `#B8472E`, `#FBF7F0`, `#E8B14B`,
  `#1F1410`, `#D6A24E`. The parity test covers `globals.css` against
  `tokens.ts` and does not reach the static assets or `viewport.themeColor`.
- **`mark-email.png` and `whatsapp-group-icon.png` still show the old A/P
  monogram.** [D-138](../decisions/D-138.md) touched no binary files, so every
  transactional email renders an AgendaProfe tile beside the word
  "spiralclass".

### From the authenticated sweep (1,164 captures, 97 routes, 2026-08-29)

- **At 1920 the teacher dashboard uses under half the width.** Content caps at
  roughly 860px and centres, so a third of the viewport is empty on each side.
  Nothing in the app responds above `lg` (1440) — `xl:` is used once in the
  whole codebase and `2xl:` never — so the widest screens get the 1440 layout
  with more margin.
- **A single stat gets a full-width card.** "Safe to spend / month" is one
  number in a card as wide as the page, followed by three sub-lines at three
  different sizes (roughly 13px, 12px, 13px) with no hierarchy explaining the
  difference. It is the clearest instance of the missing type scale.
- **The booking-link box breaks the URL mid-token**, splitting a booking slug across two lines at whatever character happens to fall at the edge —
  because the mono box wraps on character count with no control over where.
- **`secondary` buttons sit too close in value to their card background.**
  "Share on WhatsApp" and "Share on Facebook" on a raised card read as tinted
  blocks rather than controls, and the same variant looks materially different
  between light and dark.
- **"Manage" in the payments bar is clay text on a pale clay ground** — a
  contrast pairing the token system currently permits and should not.
- **The teacher greeting wraps at 390 but not 430**, leaving the header
  unbalanced against the button beside it at the more common phone width.
- **Admin stat cards mix currencies in one column** — GBP figures directly
  above MXN ones, distinguished only by the code, while the numbers carry equal
  visual weight.

Content defects a stranger also sees were found by the same sweep, and unlike
the layout findings above **all five are fixed**: the landing page advertised a
founding cohort that had been discarded (`app/page.tsx`); a booking page
rendered "1 classes × 50 min" (`web.bookingLanding.classCountDuration_one`);
`test-teacher-mira` and `test-teacher-jay` were in the public sitemap
(`lib/marketing/test-accounts.ts`, filtered in SQL by slug and address shape);
the OG card rendered in Satori's default serif behind a hardcoded Spanish
headline (`lib/og-font.ts`); and the PWA manifest description was hardcoded
Spanish opening with the pre-rename word "Agenda" (`app/manifest.ts`).
