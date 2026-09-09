# Visual content in materials

How a picture — or any non-prose graphic — gets into a teaching material, what
each of the three renderers can actually draw, and the one boundary that
constrains every future addition.

For the product rules (who may upload, what's Pro-gated, how images are
authorized and swept) see
[`features/library-materials.md`](../features/library-materials.md#images).
This document is the system design underneath them.

## Why visuals matter here

Pairing a word with a picture — _dual coding_ — is one of the better-supported
techniques in language teaching, and this is a product for language learners.
Note that "visual learners" as a learner-types theory is poorly supported by
the evidence; dual coding is a different and much sturdier claim, and it is the
one this design rests on. A picture beside a vocabulary item helps everyone
remember it, not a subset of students with a matching learning style.

## The shipped paths

The first two landed in
`#831`; the third is the
first block drawn by the app rather than uploaded.

**1. A material whose file attachment is a picture.** Rendered inline on the
student and teacher surfaces, alongside — never instead of — the existing
open/download link. Whether a file is an image is derived from the filename
inside `storage_path` (`isImageFileName`,
`packages/shared/src/material-file-kind.ts`); no MIME type is persisted on
`LibraryMaterial`, so the extension is the only signal that survives, and it
works on the whole existing corpus with no migration. Surfaced to clients as an
`isImage` wire flag, because `storagePath` itself is dropped by every mapper.

**2. An image embedded in native content.** `MaterialDoc` carries an `image`
block — `![alt](src)` alone on a line. The `alt` doubles as the visible caption
on every surface and is the only part a text-only consumer sees, which is why
it is deliberately carried into the homework-review excerpt: for a "describe
this picture" exercise, the alt _is_ the exercise.

**3. A drawn block: the tense timeline.** `MaterialDoc` carries a `timeline`
block — a `timeline`-tagged code fence holding positions and plain-text labels,
from which each platform draws its own vector graphic. It stores nothing, fetches
nothing, and a teacher can correct any label on it. See "the fence spelling" and
"what this pattern is good for" below.

### The `material-image:` reference format

An uploaded image is referenced as `material-image:<storage key>`, never a URL.
Bodies are stored and re-rendered for months; a signed URL expires in days, so
embedding one would rot the picture inside a material nobody has touched. Each
surface resolves the key at render time through an authenticated route that
302s to a freshly signed object URL — `/api/materials/images/…` on the session
cookie. The route body lives apart from the route
(`lib/materials/image-serve.ts`) because a bearer-authed sibling once had to answer identically.

The PDF is the exception and has to be: it renders server-side with no session
of its own, so it would be its own unauthenticated caller. It pre-signs every
key the document references before rendering, _after_ the answer key is
stripped, so a student copy never mints a URL for a picture that appears only
inside an `[!answer]` block.

## The boundary: no markup sink, ever

The parser has no HTML sink. That is the D-17 sanitization boundary, restated
in the parser and in all three renderers, and it is the constraint that decides
the shape of every future visual feature.

**Raw HTML is not an option.** It would be an XSS vector on web, and React
Native and the PDF cannot render it at all — so it would break three-platform
parity the day it shipped.

**Arbitrary SVG is the same problem wearing different clothes.** SVG carries
`<script>`, `<foreignObject>` and external references. This is precisely why an
uploaded `.svg` is excluded from inline preview while every raster format is
allowed: an SVG is a scriptable document, not an inert image.

The rule that follows, and the reason the rest of this document exists:

> A model may produce **data**. Only the application produces **markup**.

Anything a model authors arrives as a typed node in the document tree, and each
platform's own components decide how to draw it. There is no path by which
generated text becomes markup that a renderer evaluates.

## What each renderer can draw

Vector drawing is available on both surfaces — verified against the installed
versions, not assumed:

| Surface | Capability                                                                                                                       | Precedent in-tree           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Web     | Inline SVG; `recharts` (^3.10.0)                                                                                                 | `components/brand/logo.tsx` |
| PDF     | `@react-pdf/renderer` exposes `Svg`, `Path`, `Rect`, `Circle`, `Line`, `G`, `Polygon`, `Text`, `Tspan`, `Defs`, `LinearGradient` | —                           |

A third surface was in this table until its client was deleted. The constraint
it imposed is worth keeping in view anyway: **the geometry routine is shared and
the drawing is per-surface**, which is what made adding and then removing a
surface a local change.

Two gaps worth knowing before designing anything against this table:

- **The PDF cannot render emoji.** It uses the built-in standard PDF font
  families (no `Font.register`, no font files, no network — see
  `lib/pdf/material-doc-pdf.tsx`), and none of them carry emoji coverage. A
  design that leans on emoji needs a vector or text fallback in that renderer.
- **The PDF is fixed-layout.** A graphic sized for a phone screen is not
  reflowable there; the existing image block bounds height rather than width so
  a tall graphic cannot push the rest of a handout onto the next page.

## The extension pattern

`MaterialDoc`'s block union is the extension point — `types.ts` says so
explicitly, and the `image` block was the first addition made through it. A new
visual block type is data in the tree plus a drawing routine per surface, and
nothing else: no schema change, no migration, and no new storage lifecycle,
because the wire format stays Markdown.

Adding one means touching, in order:

1. `packages/shared/src/material-doc/types.ts` — the block variant.
2. `parse.ts` and `serialize.ts` — a spelling in the Markdown dialect, plus its
   entry in `isBlockBoundary` so a neighbouring paragraph cannot swallow it.
   **A fenced code block with a language tag is the established spelling** —
   see "the fence spelling" below; it needs no `isBlockBoundary` entry, because
   `FENCE` already is one.
3. The **round-trip contract** test. `parse(serialize(parse(body)))` must equal
   `parse(body)`; the whole structural editor rests on that being a fixed
   point, and a new block type is exactly how it gets broken.
4. Both renderers — `components/materials/material-document.tsx` (web) and
   `lib/pdf/material-doc-pdf.tsx` (PDF).
5. The block editor — `components/materials/block-editor.tsx` — plus its
   add-block menu.
6. `block-editor.ts` factories and field setters in shared, with the
   representability guard below.
7. i18n keys in all three catalogs (en, es-MX, fr).

**The representability guard.** A block that serializes to something the parser
will not read back evaporates on the next round trip — silently, in a document
the teacher believes she saved. `emptyInline()` exists for this at the inline
level, `newImageBlock` returns `null` rather than emit an unrepresentable
empty-`src` block, and a list keeps at least one item for the same reason. The
timeline's minimum is **at least one marker** — an empty axis reads back as a
code block, so `newTimelineBlock` refuses to build one and neither removal op
will leave one behind (`isRepresentableTimeline`). Any new block type needs the
equivalent: decide what its minimum viable content is, and make the factory
refuse to produce less.

### The fence spelling

Unlike `![alt](src)`, structured data has no conventional Markdown syntax. A
**fenced code block with a language tag** is what the timeline shipped with, and
what the next visual block should copy unless it has a specific reason not to:

````
```timeline
past Past
now Now
future Future
span 20 50 have lived here
point 20 I moved to Mérida
```
````

Three properties decided it:

- **The parser already tokenises it.** `FENCE` matches it today and
  `isBlockBoundary` already returns true for it, so an adjacent paragraph can
  never swallow the block — the failure mode a new line syntax would have had to
  defend against.
- **It degrades to something honest.** A renderer that predates the block — a
  teacher's copy-paste into a note app, a third party reading the Markdown —
  shows the payload as a code block. The content is visible and recoverable,
  not lost.
- **The payload stays data.** Directives with numeric positions and plain-text
  labels; nothing a renderer evaluates.

Rejected alongside it: a `:::timeline` container syntax (a second block
tokeniser, and an unknown body degrades to _nothing_ rather than to source), and
a JSON payload inside the fence (unreadable in the "edit as text" field, and one
stray comma loses the whole block where one stray line loses one directive).

**Read strictly.** A `timeline` fence whose body carries a line the parser can't
read stays a code block. Half-drawing a payload, or silently dropping the line
it couldn't parse, would lose content out of a document the teacher is about to
save over.

## What this pattern is good for

A tense timeline was the archetype and is the first one built
(`packages/shared/src/material-doc/timeline.ts`): past/present/future on a line,
with markers and a highlighted span. It is what a language teacher draws on a
whiteboard every week, and as a block it is pure data:

```
{ type: "timeline", labels: {...}, points: [...], span: {...} }
```

Web draws it as inline SVG and the PDF from the primitives in the table above —
both from **one** geometry routine (`timelineGeometry`), so the same material
cannot become two different diagrams. Labels are real platform text beside the
graphic rather than `<text>` inside it: neither surface can measure a string, so
on-axis captions would collide or overflow with no way to detect which, and
outside they wrap,
translate and get read aloud. `NOW` is fixed at the axis midpoint — one fewer
field on the wire and one fewer control in both editors, and every tense a
timeline teaches is expressible by moving the markers instead.

The same shape covers a vocabulary card grid, a clock face for telling the time,
a comparison matrix, and a word map. Those are **not** a commitment to build, and
not a queue: open work belongs on the board
([D-110](../decisions/D-110.md)), not in this repo.

**Generation does not emit timelines yet.** A teacher inserts one by hand from
the add-block menu on either client. Teaching the generation prompt to produce
them is a separate decision, deliberately not taken with the block itself.

The economics are the point. This rides the text generation the product already
pays for and already caps (100/month, shared across every AI output), so the
marginal cost of a generated graphic is zero. It stores nothing: no object, no
signed URL, no purge lifecycle, no external host fetching on render. And
because it is data rather than pixels, **a teacher can correct a wrong label** —
which she can never do to a raster.

### What it cannot do

This does not replace uploaded pictures, and should not be sold internally as
if it does.

- **It cannot produce a photograph.** For concrete-noun vocabulary — apple,
  umbrella, market stall — a diagram is not a substitute, and that is the
  classic dual-coding case. Generated visuals complement the upload path; they
  do not supersede it.
- **Model-authored freehand SVG is not the loophole.** Beyond the sink problem,
  LLMs draw structured diagrams competently and pictures badly. The quality
  argument and the security argument point the same way.
- **Free in vendor cost is not free in engineering time.** Every block type is
  the seven-step list above. Two or three well-chosen types beat a general
  diagram system.

## Alternatives considered

**Model-authored HTML or SVG.** Rejected — the sink boundary above, plus RN and
the PDF cannot render either.

**A Mermaid-style text DSL.** Mermaid is a browser JavaScript library. It has
no React Native renderer and no PDF renderer, so it would deliver a diagram on
one of three surfaces and break parity by construction.

**Free-licensed image sources** (Openverse, Wikimedia Commons). Real
photographs at no per-image cost, and the nearest thing to a substitute for
generation. Not pursued here because they carry attribution obligations and
variable quality, and because they reintroduce the external-URL fetch this
design deliberately avoids — an `<img>` loads on render with no click, so an
external source silently reports a student's IP to that host. Cheaper than
generation; not simpler.

## Related

- [`features/library-materials.md`](../features/library-materials.md) — the
  product rules for materials, including the image section.
- [D-110](../decisions/D-110.md) — why unbuilt work is not tracked in this
  repository.
