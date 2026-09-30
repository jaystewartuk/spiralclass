# Search

## Overview

One search box, in the header of every page of the teacher app and the
student portal, finds anything on the searcher's side of the product: pages,
the things she does often, her own records, and the help centre's answers. It
exists because a teacher could not find pages she used, the day plan, her
students and her packages among them. Some of those pages sat in menus under
names she did not use for them ("packets" live at Settings → Templates), and
some sat in no menu at all.

## User Stories

- As a teacher, I want to type what I call a page (like "packet" or "plan my
  day") and land on it, without knowing which menu it is filed under.
- As a teacher, I want to type a student's name and go straight to her
  page, her next class, or a message to her.
- As a teacher, I want the help centre's answer to my question to be one of
  the results.
- As a student, I want to find my classes, my teachers and the portal's pages
  the same way.

## Business Rules

### Where it is

- The search button sits beside the notifications bell (teacher) or the
  account menu (student) at every screen width. ⌘K on a Mac and Ctrl+K
  elsewhere open it from any page, even while typing in a field.
- It is not rendered on the onboarding stepper, which has no app chrome.

### What it finds

A teacher's search covers:

| Kind     | What                                                                                                                                                                 | Opens                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Page     | Every destination in the teacher nav (`packages/shared/src/nav.ts`)                                                                                                  | The page                                   |
| Shortcut | Pages no menu lists: day plan, add a student, book a class, past classes, invitations, new message, notifications, dashboard layout, acquisition profile and results | The page                                   |
| Student  | Everyone on her roster; archived students are included and marked                                                                                                    | The student's page                         |
| Shortcut | "Message {name}" for each active student                                                                                                                             | That conversation                          |
| Class    | Scheduled and completed classes from 30 days back to 60 days ahead                                                                                                   | The class                                  |
| Package  | Her package templates that are not archived                                                                                                                          | The packages page                          |
| Lead     | Her 200 most recent leads; archived leads are included and marked                                                                                                    | The leads tab holding it, searched for it  |
| Material | Her 300 most recent library items that are not archived                                                                                                              | The library, searched for it at all levels |
| Help     | Every guide, section and question in the teacher help articles                                                                                                       | The article, at that section               |

A student's search covers the portal's pages; the shortcuts to book a class,
buy a package, write a message and open help; her teachers (with a "Message
{name}" shortcut for each); her classes in the same window; and the student
help articles. **Her materials are not indexed**: what a student may see of a
library depends on her level, each item's visibility and its send time, and
the materials page owns that rule. Her search sends a query to that page
instead.

### How it matches

- Every word typed must match. A match is any part of a word, ignoring case and
  accents, so "lopez" finds "López" and "plan dia" finds "Planificación del día".
- Filler words (such as "the", "my", "where", "de", "mi", "où") are ignored
  unless they are all she typed, so "where is my packet" finds Packages.
- Each page and shortcut carries search words in each language (its
  `web.search.keywords.*` catalog entry), and a page's label in every language
  is searchable. So a teacher reading in English who types "paquetes" still
  finds Packages.
- Results are ranked by where the match landed: the start of the label first,
  then the start of a word in the label, then anywhere in the label, then only
  in the hidden search words. Ties go to pages, then shortcuts, then people,
  then packages, classes, leads and materials, then help. After that the index
  order holds, so the list does not reshuffle as she types.
- At most 12 results show, and no single kind can take more than its share
  (for example, 4 classes and 4 help answers).
- Before she types, a short list of suggestions shows.
- Every search with text ends with rows that hand the query to the page that
  searches everything of its kind. For a teacher that is students, past
  classes, materials and leads; for a student it is materials. So a record
  outside the index window is still one step away.

### Coverage is enforced

`apps/web/tests/search/destinations.test.ts` walks the route tree. It fails
when a static page under `(app)/` or `(student)/` is neither searchable nor
excluded with a stated reason. It also fails when a destination points at a
page that no longer exists. A page added to the teacher nav is searchable in
the same change, and it does not typecheck until it has search words.

## User Flow

1. She clicks the search button or presses ⌘K / Ctrl+K. The dialog opens
   with the cursor in the box and suggestions listed.
2. The index of her records loads in the background. Pages, shortcuts and help
   work before it arrives, and if it fails to load.
3. She types. The results update on every keystroke, in the browser, with
   no request per keystroke.
4. Up and down arrows move the highlight, Enter or a click opens the result,
   and Escape closes the dialog. The public booking page and the legal pages
   open in a new tab.

## Data Used

- `GET /api/teacher/search` returns the teacher's records and the teacher help
  entries. It is gated by `requireApiOnboardedTeacher`.
- `GET /api/student/search` returns the student's records and the student help
  entries. It is gated by `requireApiStudent` and scoped to every student row
  of the signed-in identity (`studentIdentityIds`).
- Both routes take no parameters, so the session's own id is the only scope.
  They answer `Cache-Control: private, no-store`.
- Labels and dates are rendered on the server, in the reader's locale and
  her own timezone. A student with no timezone falls back to UTC.
- Pages and shortcuts are built in the browser from the nav registries and the
  string catalog. Nothing about them is stored.

## Edge Cases

- **A student added a minute ago.** The record index is fetched fresh every
  time the dialog opens, so she is findable straight away.
- **A class from last spring** is outside the index window. The "Search past
  classes for …" row finds it.
- **A teacher with no booking slug yet** does not see "View public page"; it
  has nowhere to go.
- **Two roster rows of the same person with the same teacher** (student side)
  show that teacher once.

## Error States

- **The records index fails to load or times out.** A line in the dialog says
  so. Pages, shortcuts and help still work.
- **The session has expired.** The route answers 401 JSON rather than a
  redirect, and the dialog shows the same line. The next navigation takes her
  to sign-in.

## Permissions

| Who                | Can search                                                   |
| ------------------ | ------------------------------------------------------------ |
| Onboarded teacher  | Her own records, teacher pages, teacher help                 |
| Student            | Her own records, portal pages, student help                  |
| Admin              | Not this feature; the admin console has its own quick search |
| Signed-out visitor | Nothing; the box is only in the signed-in shells             |

Isolation between tenants is the `where` clause on each query (there is no
database-side RLS). `apps/web/tests/search/records.integration.test.ts` seeds
two tenants against real Postgres and asserts that neither index contains the
other's rows.
