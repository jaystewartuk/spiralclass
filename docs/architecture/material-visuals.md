# Visual content in materials

The system design under pictures and drawn graphics in a teaching material:
the boundary every visual block must respect, what each renderer can draw, and
how a new visual block type is added.

The product rules — upload limits, the Pro gate, which files preview inline,
the `material-image:` reference, authorisation and cleanup — are in
[library-materials.md](../features/library-materials.md#images). The
sanitisation boundary is [D-17](../decisions/D-17.md).

## What exists

| Visual                    | Where it lives                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A picture file attachment | Detected from the filename (`isImageFileName`, `packages/shared/src/material-file-kind.ts`)                         |
| An embedded image         | `image` block in `MaterialDoc` — `![alt](src)` alone on a line                                                      |
| A tense timeline          | `timeline` block in `MaterialDoc` — a `timeline`-tagged code fence (`packages/shared/src/material-doc/timeline.ts`) |

An uploaded image is resolved at render time through
`/api/materials/images/…`, whose body lives in `lib/materials/image-serve.ts`.
The PDF renders server-side with no session, so it pre-signs every image key
the document references (`lib/pdf/material-images.ts`) after the answer key is
stripped.

The timeline is the first block **drawn by the app** rather than uploaded. A
teacher inserts one from the block editor's add-block menu; generation does not
emit timelines.

## The boundary: no markup sink, ever

The parser has no HTML sink. That is the D-17 sanitisation boundary, restated
in the parser and in both renderers, and it decides the shape of every visual
feature:

> A model may produce **data**. Only the application produces **markup**.

- **Raw HTML is not an option.** It would be an XSS vector on the web, and the
  PDF cannot render it.
- **Arbitrary SVG is the same problem.** SVG carries `<script>`,
  `<foreignObject>` and external references, which is why an uploaded `.svg`
  never previews inline while every raster format does.
- **No external image is fetched into a PDF**, and the editors always upload a
  copy rather than writing an external URL: an `<img>` loads on render with no
  click, so an external source reports a student's IP to that host.

Anything a model authors arrives as a typed node in the document tree, and each
renderer's own components decide how to draw it.

## What each renderer can draw

| Surface | Renderer                                     | Vector drawing                                                                                                             |
| ------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Web     | `components/materials/material-document.tsx` | Inline SVG                                                                                                                 |
| PDF     | `lib/pdf/material-doc-pdf.tsx`               | `@react-pdf/renderer`'s `Svg`, `Path`, `Rect`, `Circle`, `Line`, `G`, `Polygon`, `Text`, `Tspan`, `Defs`, `LinearGradient` |

**The geometry routine is shared and the drawing is per surface.** The timeline
is drawn on both from one routine (`timelineGeometry`), so the same material
cannot become two different diagrams. Labels are real text beside the graphic
rather than `<text>` inside it: neither surface can measure a string, so
on-axis captions would collide or overflow undetectably.

Two PDF constraints to design against:

- **No emoji.** The PDF uses the built-in standard font families (no
  `Font.register`, no font files, no network), none of which carry emoji. A
  design that leans on emoji needs a vector or text fallback there.
- **Fixed layout.** A graphic sized for a phone does not reflow; the image
  block bounds height rather than width so a tall graphic cannot push the rest
  of a handout onto the next page.

## The extension pattern

`MaterialDoc`'s block union (`packages/shared/src/material-doc/types.ts`) is the
extension point. A new visual block type is data in the tree plus a drawing
routine per surface — no schema change, no migration and no new storage
lifecycle, because the wire format stays Markdown.

Adding one means touching, in order:

1. `packages/shared/src/material-doc/types.ts` — the block variant.
2. `parse.ts` and `serialize.ts` — a spelling in the Markdown dialect. Use a
   **fenced code block with a language tag** (below); any other new line syntax
   also needs an entry in `isBlockBoundary` so a neighbouring paragraph cannot
   swallow it.
3. The **round-trip contract** test: `parse(serialize(parse(body)))` must equal
   `parse(body)`. The structural editor rests on that fixed point, and a new
   block type is exactly how it gets broken.
4. Both renderers — `components/materials/material-document.tsx` and
   `lib/pdf/material-doc-pdf.tsx`.
5. The block editor — `components/materials/block-editor.tsx` — and its
   add-block menu.
6. The factories and field setters in `packages/shared/src/material-doc/block-editor.ts`,
   with the representability guard below.
7. i18n keys in every catalog (`packages/shared/src/i18n/catalog.{en,es,fr}.ts`).

**The representability guard.** A block that serializes to something the parser
will not read back evaporates on the next round trip — silently, in a document
the teacher believes she saved. `emptyInline()` guards this at the inline level,
`newImageBlock` returns `null` rather than emit an empty-`src` block, and a list
keeps at least one item. A timeline needs at least one marker (an empty axis
reads back as a code block), so `newTimelineBlock` refuses to build one and
`isRepresentableTimeline` stops either removal op from leaving one behind. Any
new block type needs the equivalent: decide its minimum viable content and make
the factory refuse to produce less.

### The fence spelling

````
```timeline
past Past
now Now
future Future
span 20 50 have lived here
point 20 I moved to Mérida
```
````

A language-tagged fence is the spelling to copy: `FENCE` in `parse.ts` already
tokenises it and is already a block boundary; a renderer that predates the
block shows the payload as a code block rather than losing it; and the payload
stays directives with numeric positions and plain-text labels. Positions run
0–100 with `NOW` fixed at 50. The parser is **strict on read**: a `timeline`
fence with a line it cannot read stays a code block rather than being
half-drawn. The full rationale, and the rejected `:::container` and JSON
spellings, are in the header of `packages/shared/src/material-doc/timeline.ts`.

Other diagrams of the same shape (a card grid, a clock face, a comparison
matrix) would follow this pattern. None is committed to; open work is an issue
([D-164](../decisions/D-164.md)). A drawn block cannot replace a photograph —
for concrete-noun vocabulary the upload path remains the answer.

## Related

- [library-materials.md](../features/library-materials.md) — the product rules
  for materials, including images
- [D-17](../decisions/D-17.md) — lesson content as native Markdown, and the
  sanitisation boundary
