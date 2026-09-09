# Library of learning materials

## Overview

Every teacher has a reusable library of teaching materials — files, external
links, or native AI-drafted/typed Markdown content — organized by **Level**
(a teacher's own ordered ladder, auto-seeded with CEFR A1–C2) and tagged with
a teacher-owned **focus-tag taxonomy** (grammar, vocabulary, skill, activity,
theme, format). A single `LibraryMaterial` row is the one entity for
"anything a teacher creates to teach with" — the same table also holds
booking-scoped, private class content and scheduled attachments (see
`docs/features/classes-lesson-content.md`); this document covers the
**reusable library** side (`bookingId` null).

From the library, a teacher can attach an item to a specific reserved class
(`BookingLibraryMaterial`) or assign it directly to a student's personal
notebook (`StudentLibraryItem`), which is visible to that student regardless
of their level. Absent an explicit assignment, a student can only _browse_
materials at or below their own level — a deliberate, non-overridable
pedagogical ceiling. Materials can also be exported to PDF (content-only) or
rendered as a generated podcast (spoken audio version).

Native content can embed **images** inline, and a material whose file
attachment is itself a picture previews inline rather than hiding behind a
download link — see "Images" below.

This page absorbed the two specs it was written from — the taxonomy spec
(tagging, AI-generate, attach, auto-surface) and the original
level-gated library design. Both were deleted with the rest of the backlog
by [D-110](../decisions/D-110.md); what was current in them is here, and
what was stale went with them.

## User Stories

- As a teacher, I want to build a library of materials once, tagged by level
  and topic, so I don't recreate the same worksheet for every student at
  that level.
- As a teacher, I want AI to draft a new library material from a topic, level,
  and tags, so I can build my library faster.
- As a teacher, I want to attach a library item to a specific upcoming class,
  scheduled to send at a chosen moment.
- As a teacher, I want to assign specific material directly to a student —
  even above their normal level — as an explicit act of accompaniment, and
  track what they've covered.
- As a student, I want to browse materials appropriate to my level, see what
  my teacher has assigned to me, and get a PDF or audio version to study
  with.

## Business Rules (exhaustive)

### Taxonomy: Level and FocusTag/FocusTagCategory

- `Level` is a **teacher-scoped, ordered table**, not a fixed enum — every
  teacher is auto-seeded with six CEFR rows (`a1`…`c2`, labels "A1"…"C2",
  positions 1–6) via `ensureTeacherLevels`, self-healing on first read if
  somehow empty. This lets a non-language tutor (math grades, music skill
  tiers) use the same mechanism without a schema change, though in practice
  the seed **is** the UI today — no settings screen exists yet to rename,
  add, reorder, or archive levels on either platform.
- `FocusTagCategory`/`FocusTag` are likewise teacher-owned tables, seeded
  from packs: a **Format** pack (10 tags — Actividad breve, Presentación,
  Lecturas, Ponte al día, Unidad didáctica, Test, Canción, Pódcast, Escape
  Room, Kahoot) layered onto **every** teacher regardless of language, plus a
  language-specific pack (Spanish ~45 tags, English ~40, or a neutral
  ~10-tag pack) chosen by the teacher's `targetLanguage`. Six categories
  exist by default: Grammar, Vocabulary, Skill, Activity, Theme, Format.
- A category can only be archived once it has **zero active tags** — enforced
  both at the application layer (an explicit "still has focus tags" error)
  and at the database layer (`onDelete: Restrict`) as a backstop. There is no
  cascade-archive-the-tags-too path; removing a category from use is always a
  conscious, visible decision.
- Limits: focus-tag label ≤ 60 characters, category label ≤ 40 characters,
  up to 300 focus tags and 60 categories per teacher.
- A library material may carry any number of the teacher's own focus tags via
  the `LibraryMaterialFocusTag` join table; posted tag ids are **always
  re-resolved against the teacher's own active tags** before writing — a
  foreign or stale id is silently dropped, never trusted as-is.

### Navigation: level-first browsing (teacher surface)

- The teacher's Materials surface opens on a **level picker**, not on the
  material list — one card/row per level in her ladder, plus an "All
  materials" escape hatch. Selecting a level opens that level's **shelf**,
  where the complete existing filter set (category, type, visibility, sort,
  search, active/archived) is unchanged.
- A shelf contains materials **filed at exactly that level** — it is not the
  student-facing `at_or_below` view. An A2 shelf shows A2 materials only, not
  A1+A2. (Chosen deliberately with the teacher this was designed with: she
  organises by where a material _lives_, not by who can see it. The
  student-facing ceiling is a separate, unchanged concept — see below.)
- **No folders, and no stored hierarchy.** A shelf is a view over
  `LibraryMaterial.levelId`, which every library material already carries.
  Re-tagging a material to a different level re-homes it with no move
  operation, no empty folder left behind, and no loss of its cross-cutting
  focus tags — none of which a real folder tree supports. Level earns the
  hierarchy position because it is the only axis on a material that is
  simultaneously mandatory, single-valued, and totally ordered
  (`Level.position`); focus tags are optional and many-per-item, so they can
  only narrow a set, never partition it.
- **No per-level counts** on the picker (explicit teacher preference), which
  is also why the picker costs no material query at all.
- Browse state is encoded in `?level=`: absent = the picker, `?level=<id>` = a
  shelf, `?level=all` = the flat all-levels list. The rule lives in
  `packages/shared/src/materials-browse.ts` rather than in the page, so the
  server and the client half cannot disagree about what a URL means.
- **Any inbound URL that already carries narrowing renders the list, never
  the picker** — an existing bookmark like `?type=file` or `?view=archived`
  keeps working instead of landing on a picker with its filters dropped.
  Likewise, searching from the picker drops straight into all-levels results,
  so a teacher who remembers the material but not its level never has to
  guess one.
- Inside a shelf, the level chip row is a **switcher**, not a filter: it moves
  sideways between shelves. Its "All" option selects the all-levels list
  explicitly rather than clearing the level (which would mean "picker").
- The in-call "My library" browser (`CallMaterialsPanel`) deliberately keeps
  the **flat** list — mid-lesson, a two-tap drill-down is a cost, not a
  feature. It shares the fetch state machine (`use-library-browser.ts`) but
  not the picker.
- The class-detail page's **attach-from-library** control gets level-first as
  _structure_ rather than as a drill-down: it is a multi-select inside a
  larger form, and replacing its list with a hub would either lose a
  selection made under another level or hide that one exists. So it keeps one
  list, grouped under level headings in ladder order
  (`groupMaterialsByLevel`), with an optional single-level narrowing. The
  checked set lives outside the list, so **a selection survives narrowing and
  still submits** — the submit button's count is what surfaces off-screen
  picks. Level headings replaced the old per-row `· A2` suffix.
- That picker is **not** defaulted to the class student's own level: the class
  page already has a separate opt-in "at their level" shelf
  (`teachers.auto_surface_level_materials`) doing exactly that, and hiding the
  rest by default would make a teacher reaching deliberately above or below
  that level think her library was empty.
- `groupMaterialsByLevel` groups in **first-encounter order**, which is ladder
  order only because both callers' `libraryMaterial.findMany` sorts by
  `level: { position: "asc" }`. Changing either `orderBy` silently loses the
  ordering — the two are coupled on purpose, rather than re-deriving an order
  the query already applied, and both sites carry a comment saying so.

### Material kind, visibility, and the browse ceiling

- A material is one of three kinds, **derived** from which fields are set
  (never stored directly), in precedence order **body > file > link** — a
  single row can carry a body **and** a file/link together (a "unified"
  material).
- `visibility` has three modes: `at_or_below` (default — the student's level
  and every level below it), `exact` (only students at precisely this level,
  e.g. a placement test), and `all` (visible regardless of level, including
  students with no level set at all — a syllabus/intro item).
- **The browse ceiling is a hard, non-overridable rule**: an A2 student
  browsing the library sees A1 + A2 materials, never B1 or above — this is
  described as pedagogical, not a nicety (a teacher does not want a student
  reaching material above their level without her guidance). The **only**
  sanctioned path above the ceiling is an explicit teacher action: assigning
  the item to that student's notebook, or attaching it to one of their
  classes.
- **A student with no level set sees zero browsable library items** — not
  even `visibility: "all"` ones. The only materials that reach a
  level-less student are ones a teacher explicitly puts in front of them
  (an assignment or a class attachment).
- Library items **never expire** — the 60-day/1-year per-class purge job that
  cleans up old booking-scoped attachments explicitly skips the
  `${teacherId}/library/...` storage prefix.
- Archiving hides an item (reversible); a separate **hard delete** frees its
  storage object and cascades its assignments — archive alone never frees
  storage.

### Attaching to a booking (`BookingLibraryMaterial`)

- Pro-gated (the same `materials` feature gate as a fresh per-class upload).
- Re-attaching the same item to the same booking is an **upsert** — it
  updates the existing row's `sendTiming` rather than creating a duplicate.
- Reuses the exact same `sendTiming` vocabulary and delivery pipeline as a
  fresh per-class upload: `confirmation`, `t_5d`, `t_24h`, `t_1h`. Attaching
  with a timing that has already elapsed (e.g. `confirmation` on an existing
  booking) sends immediately — same rule as a brand-new upload.
- This send/push behavior only applies to file/link materials — a
  native-content item (Markdown body, no file/link) attaches for on-page
  visibility only, since there is nothing to push over WhatsApp/email.
- An opt-in, per-teacher **auto-surface shelf** (`teachers.auto_surface_level_materials`,
  default off) shows a read-only "at their level" row on a class page using
  the exact same browse-ceiling query as the student's own browse surface,
  scoped to that one booking's student. Browsing this shelf is passive;
  attaching one of its items to the class is still an explicit teacher
  action.

### Materials history: what was used in a class (`ClassMaterialUse`)

A material reaches a class by three different routes, and answering "what did
we use with this student last time?" needs all three:

- **The class's own material** — a `LibraryMaterial` with `bookingId` set: a
  file, a link, or the class's Markdown lesson content.
- **An attached library item** — a `BookingLibraryMaterial` row.
- **A material opened during the call** — a `ClassMaterialUse` row. A library
  item the teacher pulls up mid-lesson and never attaches exists in no other
  table, so without this it left no trace at all.

`ClassMaterialUse` is a **teacher-private** record and is never shown to the
student, never carries a send timing, and never sends anything. That is why it
is a separate table rather than a flag on `BookingLibraryMaterial`: attaching
is a promise to the student (it schedules a WhatsApp or email delivery),
whereas opening is a fact about the lesson. Recording an open through the
attach path would push a material to the student every time the teacher merely
previewed one for herself.

- Written from every open branch of the in-call materials sheet — file, link,
  and native content, whether or not the student is in the room. Best-effort:
  the material is already open on her screen, so a failed record never undoes
  the open or surfaces an error.
- **One row per (class, material)**, not one per open. `openedAt` is therefore
  the first use in that class; `openedFor` (`teacher` / `student` / `both`)
  widens to `both` if a later open in the same class had a different audience.
- Scoped on write through both the booking and the material: a booking-scoped
  material must belong to that booking, a reusable library item may come from
  any of her classes.
- **Prepared is not used.** A class routinely attaches more material than it
  gets through, so the two facts are shown separately rather than collapsed —
  the student page's history filters on either.

Read through one query, `listStudentMaterialHistory`
(`lib/materials/class-history.ts`), which unions the three sources and
collapses them to one row per (class, material). Two surfaces consume it:

- **The student detail page's Materials history section** — grouped by class,
  date or type, filterable to "used in class" or "sent".
- **The class-content composer's "continue from a previous class" picker** —
  which offers the body-bearing subset, since a file or a link has no text to
  feed the prompt. Before this it saw only the class's own content, so a
  teacher who had taught off a library worksheet was offered nothing to
  continue from.

### Assignment + completion (the "notebook," `StudentLibraryItem`)

- Existence of a row = "assigned"; `completedAt` set = "covered." One
  assignment per (student, material) pair — re-assigning is an idempotent
  no-op.
- Assigned items are visible to the student **regardless of level** — this is
  the explicit, sanctioned path above the browse ceiling.
- **Only a reusable library item can be assigned** — a booking-scoped
  material (private to one class) is never assignable to a student's
  notebook; the assignment action verifies both the teacher-student link and
  that the material is unscoped (`bookingId: null`) before writing.
- The student is notified only on the **first** assignment of a given item
  (re-assigning/toggling doesn't re-notify).
- **Completion is teacher-driven by default** — the teacher marks an item
  covered/uncovered; the `completedBy` column records who flipped it
  ("teacher" today) and exists specifically to allow student self-marking
  later without a schema migration. No code path ever
  sets `completedBy: "student"` — self-marking is designed for, not shipped.
- Unassigning removes the notebook entry outright (not a soft-archive).

### AI generation, refine, and templates

- AI generation is **Pro-gated** and shares the exact same monthly cap (100
  generations/teacher/month) as class-content generation, refine, and
  podcast script generation — "one AI plumbing, several outputs, one quota."
  Only a successful generation burns quota.
- Generation never auto-saves: it is always "generate → review → explicit
  save." Saving a library item is a distinct action
  (`saveContentToLibraryAction` / `saveLibraryContentMaterial`) from
  generating the draft.
- A chosen **format** focus tag (Presentación, Test, Canción, etc.) is
  format-aware in the prompt — it instructs the AI to actually produce that
  shape (a worksheet has blanks, a reading has comprehension questions after
  it), not just apply a label.
- A saved `ClassContentTemplate`'s structure can be followed from either the
  class-content or the library "Generate with AI" entry point — both share
  the same prompt builder and template picker.
- "Edit with AI" (refine) applies a bounded free-text change instruction
  (≤1,000 characters) to an existing body; cannot run against an empty body.
- Generated/typed body is capped at 20,000 characters
  (`CLASS_CONTENT_MAX_CHARS`), same ceiling as class content.
- Every save that changes the body snapshots the outgoing body to
  `MaterialRevision`, capped at 20 revisions per material, oldest pruned
  first. A no-op save creates no revision. Restoring a revision is itself a
  save, so it's snapshotted too (reversible both ways).
- **Lesson continuity ("continue from a previous class")**, booking-scoped
  generation only: a teacher composing one class's content can pick one or
  more of that student's **other classes'** body-bearing content materials
  as continuation context (`listContinuationCandidatesForBooking` /
  `generateClassContentForBooking`'s `continueFromMaterialIds`,
  `lib/materials/handlers.ts`). Picking any swaps the generic "build on
  what's already covered" system directive for an explicit "this class is a
  direct continuation" instruction, and injects each chosen material's body
  (not just a title) into the prompt. Up to
  `CLASS_CONTENT_CONTINUATION_MAX_MATERIALS` (5) materials per generation,
  each truncated to `CLASS_CONTENT_CONTINUATION_MATERIAL_PROMPT_MAX_CHARS`
  (3,000 chars); the picker itself offers up to
  `CLASS_CONTENT_CONTINUATION_CANDIDATE_LIMIT` (20) previous classes, newest
  first. Candidate ids are re-scoped server-side to the same student and
  excluding the current booking on every resolve, so a stale or foreign id
  from the client is silently dropped rather than trusted. This is distinct
  from `coveredTitles` (titles only, drawn from the student's notebook of
  assigned/completed library items) — continuation carries the actual prior
  content so the model can reinforce specifics and pick up where a
  particular class left off, rather than just avoiding a list of titles.

### Podcast generation (`MaterialPodcast`)

- One podcast per material (`materialId` unique); regenerating **reuses** the
  same row, flipping its status back to `pending`.
- Shares the same Pro gate and monthly AI-cap quota pool as text generation —
  a successful podcast burns one unit from the same 100/month cap.
- Requires **both** an AI (script) vendor and a TTS vendor configured; either
  missing yields a "not available" message rather than a partial result.
- Requires the material to already have a non-empty body — cannot generate a
  podcast from a file/link-only material. The narrator is handed the STUDENT
  copy of that body (see "Answer key visibility"), so a material whose body is
  nothing but an answer key has nothing to narrate and is rejected the same
  way an empty one is.
- Requesting a podcast while one is already `pending` is a no-op
  (`already-pending`), not an error.
- Script is capped at 8,000 characters (`PODCAST_SCRIPT_MAX_CHARS`); default
  target duration is ~4 minutes at ~150 spoken words/minute; the rendered
  audio file is capped at 25 MB.
- Quota is burned only on the job's success path, never on enqueue or
  failure — a retry after a prior success is a guarded no-op and never
  double-burns quota.
- Playback is always a short-lived signed URL, never a public link.

### Answer key visibility

The AI generator puts every solution in a `> [!answer]` callout specifically so
it can be held back, and the on-screen renderers collapse those behind a "Show
answer" toggle. **That toggle is presentation, not a boundary** — a device that
holds the body can reveal it with a tap, or read it out of the page payload,
the API response or the call's data packet. So the rule is not "hide the
answers from students" but "never send them":

- **The teacher's copy is the authoring copy** and keeps the answer key
  everywhere she reads it — her dashboard, her class page, her in-call viewer,
  the `?answers=1` PDF. She is the one person meant to see it.
- **Every student-facing producer serves the stripped copy**, cut at any
  nesting depth (an answer inside a question callout, or under a list item,
  goes too) before the bytes leave the server: her in-call materials list, her
  materials page, and her class page and its print view.
- **The in-call data channel strips at both ends.** A material the teacher
  opens on the student's screen may come straight from her library and so never
  passed a server-side resolver at all — so the encoder makes the cut, and the
  decoder makes it again on arrival. The redundancy is deliberate: a peer on an
  older build is not ours to update mid-call.
- **A generated podcast narrates the stripped body**, so the answers can't be
  listened to instead of read. The cut is made on the script prompt, so the
  model is never told the solutions and cannot allude to them either. A
  podcast synthesized before this rule existed still contains whatever it was
  generated from — regenerate to refresh it.
- **A material that is nothing but an answer key** strips to an empty body,
  not to null: it is still a content material with nothing left to show. The
  podcast job treats that as terminally invalid rather than narrating silence.
- Embedded images follow for free — a `material-image:` reference that appears
  only inside an answer callout is removed with the callout, so a student copy
  never resolves a picture that only illustrates a solution.

The cut itself is one shared pure function (`stripAnswerKeyMarkdown` over
`ANSWER_KEY_CALLOUTS`) so the page, the data channel and the PDF cannot
disagree about what counts as an answer.

### Images

Two independent things, both added for visual learners (dual coding — pairing
a word with a picture is one of the best-supported techniques in language
teaching, and the reason a vocabulary or "describe this scene" activity wants
a picture at all):

- **Inline preview of an image file attachment.** A material whose file is a
  raster image (`jpg`, `jpeg`, `png`, `webp`, `gif`, `avif`, `heic`, `heif`)
  renders the picture inline on the student surfaces, alongside — never
  instead of — the existing open/download link. **SVG is deliberately
  excluded**: it is a scriptable document, not an inert raster, and rendering
  one inline would reintroduce the HTML sink the material renderers exist to
  avoid (D-17). The image/not-image decision is derived from the **filename**
  inside `storage_path` (`isImageFileName`, `packages/shared/src/
material-file-kind.ts`): no MIME type is persisted on `LibraryMaterial`, and
  the extension works on the entire existing corpus with no migration or
  backfill. Surfaced to clients as an `isImage` flag on the wire types, since
  `storagePath` itself is dropped by every wire mapper. The in-call viewer asks
  the same module a three-way version of that question (`materialFileKind` →
  `pdf` / `image` / `other`, carried on the wire as `fileKind`), because it can
  also render a PDF; the SVG exclusion holds there identically — an `.svg` is
  `other`, and `other` means "opens outside the call".
- **Images embedded in native content.** `MaterialDoc` has an `image` block —
  `![alt](src)` **alone on a line** (an image mid-sentence stays literal text;
  there is no inline image node, so no renderer has to place a picture inside
  a text run). The `alt` doubles as the visible caption on every surface, and
  is the only part a text-only consumer sees — it is deliberately carried into
  the homework-review excerpt, because for a "describe this picture" exercise
  the alt IS the exercise.

`src` is one of two things:

- `material-image:<storage key>` — an image the teacher uploaded from the
  block editor. The body stores the **storage key, never a URL**: bodies are
  kept and re-rendered for months, and a signed URL expires in days, so
  embedding one would rot the picture. Each surface resolves the key at
  render time through an authenticated route (`/api/materials/images/…`) that
  302s to a freshly signed object URL.
- an external `https://` URL — parsed and rendered, but never written by the
  editors, which always upload a copy. `http:`, `data:`, `javascript:` and
  everything else are rejected at each renderer's sink and degrade to the
  caption, the same allow-list discipline link hrefs already get. The reason
  images are stricter than links: an `<img>` is fetched on render with no
  click, so an external src silently reports the student's IP to that host.

Rules:

- Upload is **Pro-gated** on the same `class_content` entitlement as authoring
  the body the image goes into, capped at **8 MB** (smaller than the 25 MB
  generic material file cap — this is an illustration a student may load
  several of on a phone connection), and restricted to `image/jpeg`,
  `image/png`,
  `image/webp`, `image/gif`. The stored extension is **derived from the
  declared content type**, never from the uploaded filename, so a
  mis-announced file can only ever be decoded as what it claimed to be.
- Objects live at `${teacherId}/library/images/…` — inside the `library/`
  prefix the time-based per-class purge job skips, so an embedded image is
  never swept out from under the body referencing it.
- **Authorization is teacher-scoped, not per-material**: the image's owning
  teacher, or any student on that teacher's roster (over the full identity
  set, so a student who studies with several teachers isn't locked out). An
  image's key names a teacher but not a material, and one picture can appear
  in several materials at once, so there is no single material to check
  against. Every failure is a 404, never a 403, so a caller can't confirm
  which keys exist.
- Hard-deleting a material frees the images its body embedded, but only those
  **no other material of that teacher still references** — duplicating a
  section copies its Markdown verbatim, so an unconditional delete would blank
  a picture inside a material the teacher never touched. Archiving frees
  nothing, same as for a file attachment.
- The **PDF export** cannot use the authenticated route (it renders
  server-side with no session), so it pre-signs each embedded image before
  rendering — after the answer key is stripped, so a student copy never mints
  a URL for a picture that only appears inside an `[!answer]` block. An
  external https image is **not** fetched into a PDF, and a key that fails to
  sign degrades to its caption rather than failing the whole download.
- AI generation remains **text-only**: nothing in the prompt emits image
  syntax, so a generated draft never references a picture that doesn't exist.

### Storage & uploads

- File uploads are capped at 25 MB.
- Library files live under a distinct `${teacherId}/library/...` storage
  prefix specifically so the time-based per-class purge job never touches
  them.
- Hard-deleting a material frees its storage object (best-effort) before
  deleting the row; archiving never frees storage.

### PDF export

- Only materials with a non-empty **body** (native content) can export to
  PDF — a pure file/link material has nothing to render and the route
  returns 404 the same way it would for a not-found or not-owned material
  (never leaking which reason applied).
- The exported filename is derived from the material's label, ASCII-folded
  and slug-safe, capped at 60 characters, falling back to `"material.pdf"` if
  empty.

## User Flow

**Teacher — building the library:**

1. Open Materials (`/dashboard/materials`).
2. Choose "Add material" → pick a method: write, generate with AI, or
   upload a file/link.
3. Choose a level (required), optional unit grouping, and a visibility mode
   (defaults to at-or-below).
4. For AI: supply a topic and/or focus/format tags and, optionally, a saved
   template; review the Markdown draft; edit or refine it; save explicitly.
5. Optionally tag the saved item with focus tags from the teacher's own
   taxonomy.
6. The item appears in the teacher's library, ordered within its level.

**Teacher — attaching to a class:**

1. Open a booking's Materials panel.
2. Either upload something new for just this class (with a scheduled send
   time), or pick one or more existing library items to attach (multi-select,
   same send-timing options).
3. Optionally rely on the opt-in "at their level" shelf that surfaces
   matching browse-ceiling items automatically for one-click attach.

**Teacher — assigning to a student's notebook:**

1. Open a student's profile.
2. Pick any library item (any level — assignment bypasses the ceiling) and
   assign it; the student is notified on first assignment only.
3. Mark items covered/uncovered as teaching progresses; a running "X of N
   covered" count is shown.

**Student — browsing and consuming:**

1. Visit the materials surface (`/my-classes/materials`). See three sources
   merged: items browsable at their level, items
   explicitly assigned to them (any level), and items attached to their
   specific classes.
2. Every row names its own source: an assigned item is badged as assigned, a
   class attachment carries the date of the class it came from, and a level
   item carries neither, because it is the default. Alongside those the row
   shows the material's type, level, unit and tags, and — for an assigned
   item — whether the teacher has marked it covered.
3. Narrow the shelf by source (everything, from your teacher, from your
   classes, at your level) or by searching name, topic, level, tag and the
   opening of a lesson's body. Both live in the URL (`?show=`, `?q=`), so a
   narrowed shelf is bookmarkable and works without JavaScript. The toolbar
   only appears once a shelf is big enough to need it.
4. Open a file/link (signed URL minted per request), read native content
   inline, download a PDF of a content item, or listen to its generated
   podcast if one exists.

## Data Used

Level ladder (per teacher), focus-tag taxonomy (categories + tags, per
teacher), library materials (file/link/body, level, visibility, unit,
position, tags), per-booking attachments with send timing, per-class use
records (what was opened during a lesson, and for whom), per-student
assignment + completion state, revision history, and generated podcast
audio + script.

## Edge Cases

- A student with no level assigned browses the library: sees nothing on the
  browse surface, only explicit assignments/class attachments.
- A teacher moves an item to a different level: it's re-homed to the end of
  the destination level's ordering, never colliding with an existing
  position there.
- Deselecting every focus tag on an edit (posting zero tag ids): still
  clears existing tags, distinguished from a client that never rendered the
  tag picker at all (which leaves existing tags untouched) via an explicit
  "tags were present" marker field.
- Re-attaching an already-attached item to the same booking: updates the
  existing attachment's send timing rather than duplicating it.
- Attaching a native-content item to a booking with a push-eligible send
  timing: the timing is stored but nothing is actually pushed (no
  file/link to send).
- Re-assigning an already-assigned item: idempotent no-op, no duplicate
  notification.
- Hard-deleting a material that has active assignments: cascades and removes
  those `StudentLibraryItem` rows too.
- Regenerating a podcast on a material whose body changed since the last
  generation: reuses the same podcast row, discarding the prior audio/script.

## Error States

- Category archive attempted while active tags remain →
  explicit "still has focus tags" error, category not archived.
- Posted focus-tag ids from another teacher (attempted cross-tenant
  reference) → silently ignored, no mutation, no error surfaced.
- PDF export: 401 if unauthenticated; 404 for not-found, not-owned, or a
  file/link-only material (no distinguishing signal between these cases).
- Podcast request: `not-pro`, `cap` (monthly limit reached), `not-found`
  (material missing/not owned), `invalid` (empty body), `not-configured`
  (missing vendor credentials), `already-pending` (not an error to the
  teacher — the UI just shows in-progress).
- AI generation/refine with no topic and no tags, or an empty refine
  instruction, or refining an empty body → validation error before any model
  call.
- Monthly AI cap reached → capped error, no model call, no quota burned;
  manual authoring still available.
- Attach/assign action referencing a booking, student, or material not owned
  by the calling teacher → not-found/no-op.

## Permissions

| Action                                  | Teacher (owner)         | Other teacher | Student                                                      |
| --------------------------------------- | ----------------------- | ------------- | ------------------------------------------------------------ |
| Browse library (level-capped)           | Yes (all own)           | No            | Yes, capped at their level                                   |
| Create/upload material                  | Yes                     | No            | No                                                           |
| Generate with AI / refine / podcast     | Yes (Pro + monthly cap) | No            | No                                                           |
| Edit body / view + restore revisions    | Yes                     | No            | No                                                           |
| Archive / hard-delete                   | Yes                     | No            | No                                                           |
| Reorder within a level                  | Yes                     | No            | No                                                           |
| Manage focus tags/categories            | Yes (Pro to save)       | No            | No                                                           |
| Attach material to a booking            | Yes (Pro)               | No            | No                                                           |
| Assign material to a student (notebook) | Yes                     | No            | No (read-only)                                               |
| Mark assignment completed               | Yes (default)           | No            | No (not yet shipped)                                         |
| Set a student's level                   | Yes                     | No            | No                                                           |
| View assigned/class materials           | Yes                     | No            | Yes (own only)                                               |
| Export material PDF                     | Yes                     | No            | Presumably yes for own materials, via the same route pattern |
| See a material's answer key             | Yes                     | No            | **Never** — cut server-side from every student surface       |

No moderation or approval workflow exists — every material is teacher-owned
and strictly tenant-scoped; there is no platform admin review step.

## Open Questions

- Whether a student will ever be allowed to self-mark a notebook item
  "done" (`completedBy: "student"`) is an explicitly open, deferred
  sub-decision carried over from the deleted level-materials spec — the
  column exists to support
  it but no code path sets it today.
- No level-ladder management UI (rename/add/reorder/archive a level) exists,
  despite being called out as a "purely additive, cheap"
  follow-up — still roadmap only.
- Bulk/multi-file upload is still listed as a roadmap item — today's upload
  flow is one file or link at a time.
- The exact precedence when a material appears in more than one of the
  student's three surfaces at once (browsable + assigned + class-attached)
  wasn't independently confirmed to a single, tested ordering in this pass —
  worth a targeted test read (`student-view.ts` / its test suite) before
  writing QA cases that depend on display order.
