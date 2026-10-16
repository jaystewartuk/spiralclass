# Decision records

**Why SpiralClass is shaped the way it is**, written as the work happened rather
than reconstructed afterwards. Several reverse an earlier one. A few say plainly
that the author got something wrong, and what it cost.

This log is **current policy, not history** — before reversing anything a
decision constrains, read its `D-NN.md` first.

---

## How to read this log

**These are working engineering notes, not marketing.** They were written to be
useful to whoever picked the code up next — which for most of this project's
life meant the author, six weeks later, having forgotten why. That audience
shapes the register: they are blunt, they show their arithmetic, and they name
what is still wrong.

Four conventions are worth knowing before reading any of them.

- **A record is usually the fix, not the failure.** The problem is described in
  full because the reasoning is the point — but the decision at the top of the
  file is generally the thing that resolved it. [D-135](./D-135.md) reads
  starkly about video retention; it is the decision that _stopped_ capturing
  video, and [D-136](./D-136.md) closes the retention gap it names.
- **Unresolved risks are stated, not buried.** Most entries end with what the
  decision did _not_ fix, what was accepted, and what would reopen it. A record
  that names an open gap is a record doing its job — the alternative is a log
  that only says what went well, which is worth nothing to the next person.
- **One record per live decision, amended in place** ([D-202](./D-202.md)).
  A record that a later one absorbed is deleted and its number is listed under
  [Retired numbers](#retired-numbers) with where its reasoning went. The
  original records are in git history.
- **Read alongside the code, not instead of it.** Several records describe
  software that has since changed; the status line at the top of a record is
  the only claim about what is live today.

**Context on scale.** This was built and operated by one person, with a
handful of real teachers and their students on it. Decisions that would go to
legal, security review or a change-advisory board in a larger organisation were
made by one person, in writing, here. That is what these
files are: the review board, written down.

---

## What is not here

**This is a curated subset of the working log, and the gaps in the numbering
are real.** **51 records were removed before publication**, in three groups. None of them answers "why is it built this way rather than
another way" about anything that still exists.

- **20 — a second client and the arc that ended it.** A complete mobile app:
  tab-bar arrangements, header bars, versioning and the build pipeline, its
  API-compatibility policy, plus the four records that froze it, deleted it,
  retired its API tree and removed its push transport. It earned nothing across its production life and
  is gone; nothing in the tree depends on the reasoning that ended it.
- **15 — infrastructure churn whose lesson its successors carry.** CI moved
  between GitHub-hosted runners, a free Oracle ARM box and a paid Hetzner pool
  four times before [D-157](./D-157.md) put it on a laptop and
  [D-157](./D-157.md) put it back on runners; three OpenTofu modules were
  written and never applied. The surviving arc is
  D-157, plus [D-139](./D-139.md) and [D-164](./D-164.md), which
  are the two records that state what the churn actually taught.
- **16 — implementation notes and superseded product detail.** A bug-fix pass,
  a settings-page CRUD manager, a feature shipped with no rejected
  alternative, a product surface that was built, retired and then deleted
  outright together with the record of its retirement, and decisions whose
  successor tells the whole story better (phone-OTP sign-in and device trust,
  both reversed by [D-40](./D-40.md)).

**Numbering is never reused and never renumbered.** A gap means a record was
removed or retired, not that one is missing.

**Everything kept is unedited**, except where a record named an account
identifier ([D-158](./D-158.md)) or the maintainer's personal legal position
([D-159](./D-159.md)), and except for dated forward pointers added at the head
of records that were later reversed. Where a removed record was cited by one
that stayed, the citation was rewritten to state the fact rather than to link
at nothing.

---

## Start here

**If you have ten minutes, read
[READ-THIS-FIRST.md](./READ-THIS-FIRST.md)** — three of these decisions told end
to end, with what each one cost. It is one page and it needs no other file.

**The index below is a wall, and nobody reads a wall.** If you want more than
those three, read these next. The criterion is not importance — it is judgement under a real
constraint, which is the one thing a log can show that a codebase cannot.

### A decision reversed, and the reason it reversed

- **[D-143](./D-143.md)** — the teacher becomes the merchant of record. The
  payments architecture had absorbed a hard constraint (a UK platform cannot
  `Transfer` to an account outside its payout circle) instead of isolating it. The fix was not to
  route around the payout circle but to stop needing one. Three addenda record
  what only appeared once a real teacher onboarded, including the fact that a
  connected account, once created, **can never be deleted**.
- **[D-157](./D-157.md)** — every GitHub Actions workflow in the repository is
  deleted and the laptop runs the checks by hand, after the Actions allowance
  emptied mid-month and production's database went eleven days without a
  backup. **[D-157](./D-157.md)** brings three of them back once the repository
  is public, on one condition: the workflows _call_ the check registry and the
  deploy script, and never restate either.
- **[D-141](./D-141.md)** — a bespoke breakpoint scale is withdrawn. Its
  observation was right (a tablet is a touch device, not a small desktop) and
  it had answered it in the wrong dimension: width cannot tell a 1280px tablet
  from a 1280px browser window. `pointer: coarse` can.

### A cost measured before the decision, not asserted after it

- **[D-115](./D-115.md)** — 87 database wake windows measured over 23 hours,
  decomposed into 72% idle scale-to-zero timer. One 15-minute reminder leg was
  costing roughly half the free compute allowance. It keeps the reminder and
  gets the hourly grid, by arming a delayed event at the exact due moment.
- **[D-184](./D-184.md)** — round-trip latency measured from the actual
  machines, then multiplied by a documented query pattern: moving the app to a
  free box would cost ~1.3 seconds on a database-heavy page. The free option
  loses, and the record says so.

### Something found, and then fixed

- **[D-136](./D-136.md)** — the published retention table promised that closing
  an account destroys its recordings, and the code did not do it. This is the
  change that makes the sentence true, not a new policy.
- **[D-157](./D-157.md)** — 1,265 tests in the shared packages were run by no
  step in the gate's registry. Adding one found a timezone defect that every
  UTC machine agreed was correct.

- **[D-140](./D-140.md)**'s correction — three guards were watching the type
  scale and none fired, because each derived its bound from the thing it was
  guarding. A test that asserts every step is at least as large as the smallest
  step certifies the exact violation it exists to catch.

### Where the money goes, and where it deliberately does not

- **[D-143](./D-143.md)** — "the platform never touches the funds" is promoted
  from an incidental property to a constraint that governs every future
  payments decision, and every vendor that looks like the answer is named and
  rejected on the same point.
- **[D-153](./D-153.md)** — money columns stop saying `centavos`. Eight of the
  supported currencies have no hundredth part at all, so the old name did not
  merely use the wrong word — it named a unit that does not exist, and invited
  a `/ 100` that had already cost a 100× pricing error.

---

## By theme

### Payments — money in, money out

Two independent rails, and five months of learning that the platform should not
be in the middle of either. The card rail moved from the platform being merchant
of record to the teacher being one; the manual rail generalised from a single
vendor to a per-country scheme registry, then contracted again when Stripe
closed the gap from the other side.

| #                   | Decision                                                                               |
| ------------------- | -------------------------------------------------------------------------------------- |
| [D-79](./D-79.md)   | Webhook durability: a claim recorded before the handler ran swallowed Stripe's retries |
| [D-143](./D-143.md) | **The teacher becomes merchant of record — Connect direct charges on Accounts v2**     |
| [D-145](./D-145.md) | The manual bank-account rail is removed once Stripe began presenting SPEI itself       |
| [D-153](./D-153.md) | Money columns say `minor_units` — eight supported currencies have no minor unit        |

### Scheduling, packages and credits

Where correctness is bought with database constraints rather than
application-level checking — a partial unique index and two `EXCLUDE`
constraints, not a pre-flight check — and where two defaults were reversed once
someone worked out what they actually cost a student.

| #                   | Decision                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| [D-53](./D-53.md)   | Each availability rule is frozen in the zone it was written in                              |
| [D-149](./D-149.md) | Group classes are one booking with many attendees, because the exclusion constraint says so |

### Identity, authentication and access

A student can belong to several teachers, which is the single most consequential
modelling decision in the product and shapes every query in the student tree.

| #                   | Decision                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| [D-25](./D-25.md)   | Superadmin hardened: mandatory MFA, append-only audit at the database, attributed impersonation  |
| [D-38](./D-38.md)   | Teacher and Student are mutually exclusive per auth identity — a payee is not a payer            |
| [D-40](./D-40.md)   | **Replace Supabase Auth with better-auth on our own tables** — auth travels with the database    |
| [D-55](./D-55.md)   | An admin capability layer beneath the rank ladder, and a runbook that is a page, not a doc       |
| [D-56](./D-56.md)   | `/sign-in` never auto-provisions a teacher; intent comes from the page, never from a miss        |
| [D-83](./D-83.md)   | Teacher → student invitations: hashed tokens, one pending per pair, idempotent acceptance        |
| [D-104](./D-104.md) | Public listing gates on Marketplace Ready, not on having submitted the wizard                    |
| [D-175](./D-175.md) | **Tenant scoping is checked by a parser, not by a reader** — a ratchet, and five decoys it fails |

### Video and real time

Owning the call was never about the call. It was about owning the media the
lesson-AI pipeline needs — and about being able to overlay the teacher's notes
on it.

| #                   | Decision                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [D-16](./D-16.md)   | **A `VideoProvider` seam** — the Cloud → self-hosted move changed two config values                                       |
| [D-27](./D-27.md)   | Live captions, client-streamed and ephemeral, because serverless cannot host a worker                                     |
| [D-94](./D-94.md)   | Production cuts over to the self-hosted LiveKit box — an explicit risk acceptance                                         |
| [D-106](./D-106.md) | Captions move to a server-side agent once the constraint behind D-27 stopped being true                                   |
| [D-108](./D-108.md) | The agent ships from a real checkout on the box — the outage was provenance, not the bug                                  |
| [D-132](./D-132.md) | Auto-start recording when both parties are present — who starts it, never what it captures                                |
| [D-134](./D-134.md) | The media host goes behind Cloudflare's proxy, after one teacher's iPhone could not join                                  |
| [D-135](./D-135.md) | Recording becomes audio-only: the first real class produced an 846 MB file                                                |
| [D-182](./D-182.md) | Production goes back to LiveKit Cloud while Oracle refuses to rebuild the box                                             |
| [D-185](./D-185.md) | **Captions move into the browsers**, and a computer in the call covers a phone that cannot; two phones stream to Deepgram |
| [D-187](./D-187.md) | **Production video moves to a free `e2-micro`** — measured to carry a class, not its recording, so recording goes off     |
| [D-189](./D-189.md) | **The lesson transcript is the caption text the browsers already recognise**, kept with consent — no audio, no egress     |
| [D-198](./D-198.md) | **A caption shows the words as they are spoken**; the translation replaces them when the phrase ends                      |

### The lesson-AI pipeline, and the consent that gates it

Buy the commodity ML, build the data model and the teacher-validation loop.
Capture is gated by a recorded per-pairing consent — guardian-only for a minor —
which is a separate control from the flag that turns the capability on.

| #                   | Decision                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- |
| [D-19](./D-19.md)   | **Async post-class pipeline, per-speaker audio, derive-then-discard**                        |
| [D-21](./D-21.md)   | Retention is keep-on-opt-in; the recording indicator is necessary and not sufficient         |
| [D-22](./D-22.md)   | Capture requires an explicit per-student, minor-aware consent, enforced at the capture site  |
| [D-23](./D-23.md)   | Admin sees pipeline status and counts, never voice-derived content                           |
| [D-87](./D-87.md)   | Model defaults split by call shape — and `effort` 400s on Haiku, which a blanket move missed |
| [D-88](./D-88.md)   | One-to-one is an always-on prompt directive, not a per-form option nobody can change         |
| [D-97](./D-97.md)   | Bookmarks derive their offset rather than storing one; the profile survives with no insights |
| [D-114](./D-114.md) | Turn transcription and recording off — and the capture bug that flag flip exposed            |
| [D-131](./D-131.md) | Turn them back on, and correct the four sentences of the privacy policy that said otherwise  |
| [D-136](./D-136.md) | Closing an account destroys its recordings — making a published promise true                 |

### Teaching content and materials

The recurring line: the platform owns the machinery, the teacher owns the
method. No platform curriculum, ever.

| #                   | Decision                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| [D-17](./D-17.md)   | Native structured content, not distributed PDFs; AI authoring in-house and Pro-gated        |
| [D-20](./D-20.md)   | **Inputs are teacher-owned seeded rows, not a platform curriculum library**                 |
| [D-46](./D-46.md)   | A teacher's own lesson template drives AI compose — wire the primitive, don't bake a method |
| [D-78](./D-78.md)   | Account-level AI style as presets plus a bounded note — never a raw editable system prompt  |
| [D-80](./D-80.md)   | Vocabulary difficulty is its own axis; CEFR level was doing double duty as a rarity dial    |
| [D-93](./D-93.md)   | Homework review and AI-assist architecture — designed first, then built in slices           |
| [D-107](./D-107.md) | Materials opens on a level picker: level is the only mandatory, single-valued, ordered axis |

### Notifications and messaging

| #   | Decision |
| --- | -------- |

### Acquisition and the public funnel

Amplify the teacher's own reach; never become a marketplace. The automation
boundary is explicit: the product does everything around participating in a
community and nothing that constitutes participating in one.

| #                   | Decision                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| [D-24](./D-24.md)   | Acquisition is teacher amplification, in-app, not a directory                                         |
| [D-42](./D-42.md)   | Remove the WhatsApp Cloud API integration; keep the phone field and plain deep links                  |
| [D-73](./D-73.md)   | A self-hosted intro video, because owning the file is what makes the AI coach possible                |
| [D-123](./D-123.md) | Social previews attach to the share **link**; the model draws no text, we render every character      |
| [D-125](./D-125.md) | **A planner that is a pure function** — Claude writes the words, it never decides what a number means |
| [D-142](./D-142.md) | The public demo is a rendered fixture: a demo account needs a sign-in that proves nothing             |
| [D-151](./D-151.md) | A testimonial the teacher cannot write — a CHECK constraint ties the badge to a real student          |
| [D-155](./D-155.md) | The generated memes were all a shocked face because our own prompt asked for one                      |

### Language, i18n and copy

A teacher has four independent language fields and conflating any two of them
has broken production.

| #                   | Decision                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| [D-52](./D-52.md)   | One shared key-based catalog, completeness as a type error, plus a ratchet and a lint rule |
| [D-72](./D-72.md)   | One 174-entry registry from CLDR; language-first framing widened by D-173                  |
| [D-81](./D-81.md)   | A third UI language, on a registry where adding one is two steps                           |
| [D-112](./D-112.md) | Ask for the teaching language at onboarding — an unset value silently seeds the wrong pack |
| [D-173](./D-173.md) | Teachers of **any subject** — the copy widened, the language-shaped schema did not         |
| [D-193](./D-193.md) | **One URL per language** on public pages: `/es/…`, `/fr/…`, and the bare URL is English    |
| [D-194](./D-194.md) | A visitor cannot switch a booking page's language until the teacher can write in several   |
| [D-195](./D-195.md) | One locale per language until a region earns one; a regional locale is a delta, not a copy |
| [D-196](./D-196.md) | Legal text is translated by a person, English controls, no launch without it               |

### Design and layout

| #                   | Decision                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| [D-122](./D-122.md) | A tablet is a phone with more room — the scale moves above every tablet width                  |
| [D-140](./D-140.md) | **Legibility outranks identity**, and the correction where the stated floor was never held     |
| [D-141](./D-141.md) | The standard scale is restored; the touch question moves to `pointer: coarse` where it belongs |

### Subscriptions, entitlements and unit economics

| #   | Decision |
| --- | -------- |

### Database, hosting and configuration

The three-layer thesis — provision, schema, data — written before it was needed
and exercised for real when the provider actually changed.

| #                   | Decision                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [D-70](./D-70.md)   | **Full exit from Supabase and Vercel**; 125 migrations squashed to one portable baseline                                                                  |
| [D-115](./D-115.md) | Collapse the cron wake grid; serve the tight leg with a delayed-event chain                                                                               |
| [D-127](./D-127.md) | Image generation moves to Vertex AI — the consumer API gates on a prepay balance                                                                          |
| [D-139](./D-139.md) | **Delete the OpenTofu modules that were never applied** — they assert a state nobody reconciled                                                           |
| [D-170](./D-170.md) | The Codespaces path is **deleted rather than repaired** — a development path with no users is not a feature                                               |
| [D-178](./D-178.md) | **A migration must work with the code already serving**; drops ship a release after the code stops using them                                             |
| [D-184](./D-184.md) | **Cloud Run `us-east4` takes production from Fly** — measured at +9 ms to Neon, against the +46 ms D-184 refused; serving since 2026-09-23, Fly destroyed |

### CI, the gate and releasing

One registry defines what "green" means. Everything else — a laptop, a runner,
a hook — is a caller.

| #                   | Decision                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- |
| [D-157](./D-157.md) | **Actions comes back on one condition**: the workflows call the registry and restate nothing |
| [D-163](./D-163.md) | One home for a deploy value — and the same-day reversal of the mechanism, with the reason    |
| [D-164](./D-164.md) | **A runbook for infrastructure that does not exist is deleted, not banner-ed**               |
| [D-179](./D-179.md) | **CodeQL gates on new alerts through a ruleset**, not a workflow and not a required check    |
| [D-199](./D-199.md) | **A merge starts its own production deploy**; the owner's approval is the release decision   |

### Privacy, governance and publication

| #                   | Decision                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| [D-05](./D-05.md)   | _(tombstone)_ An early privacy framing, superseded by D-128 and removed before publication               |
| [D-110](./D-110.md) | One board, off this repository: 100 documents that were really queues of work are deleted                |
| [D-172](./D-172.md) | The board moves into this repository's Issues — the queue stays out of the tree, and stops being private |
| [D-128](./D-128.md) | The privacy layer becomes UK GDPR, and **the supplier register becomes code with a guard test**          |
| [D-147](./D-147.md) | _(tombstone)_ The regulatory position, kept privately — with the one engineering finding                 |
| [D-158](./D-158.md) | Publish the shape, never the account — a third gate on the credential scanner                            |
| [D-159](./D-159.md) | What was built is published; what the operator personally owes is not                                    |
| [D-181](./D-181.md) | **A security fix lands as a public PR with a neutral title**, pushed only when it can ship               |
| [D-202](./D-202.md) | **One record per live decision, edited in place**; absorbed numbers retired, never reused                |

### Naming and positioning

| #                   | Decision                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------- |
| [D-133](./D-133.md) | Keep the name — costed against ~55 checked alternatives, and the cost of keeping it stated    |
| [D-138](./D-138.md) | Rename anyway, at the switching cost's floor, and the 45 identifiers deliberately not renamed |

---

## Every record, by number

Numbering follows the order decisions were made and is never reused. Gaps are
records removed before publication — see [What is not here](#what-is-not-here).

| #                   | Decision                                                              | Status                               |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| [D-05](./D-05.md)   | Early privacy framing                                                 | Superseded by D-128; content removed |
| [D-16](./D-16.md)   | Own the call behind a `VideoProvider` seam                            | Active                               |
| [D-17](./D-17.md)   | Native structured content, not PDFs; AI authoring in-house            | Active (model choice → D-87)         |
| [D-19](./D-19.md)   | Lesson insights: async, buy the ML, derive-then-discard               | Active (model choice → D-87)         |
| [D-20](./D-20.md)   | Teacher-owned seeded inputs, not a platform curriculum                | Active (one call → D-72)             |
| [D-21](./D-21.md)   | Keep-on-opt-in retention + the consent model                          | Active                               |
| [D-22](./D-22.md)   | Capture gated on per-student, minor-aware consent                     | Active                               |
| [D-23](./D-23.md)   | Admin sees pipeline status, never voice-derived content               | Active                               |
| [D-24](./D-24.md)   | Acquisition is teacher amplification, not a marketplace               | Active                               |
| [D-25](./D-25.md)   | Superadmin hardened: MFA, append-only audit, impersonation rules      | Active                               |
| [D-27](./D-27.md)   | Live captions, client-streamed and ephemeral                          | Superseded in part by D-106          |
| [D-38](./D-38.md)   | Teacher and Student mutually exclusive per identity                   | Active                               |
| [D-40](./D-40.md)   | Supabase Auth → better-auth on owned tables                           | Active                               |
| [D-42](./D-42.md)   | Remove the WhatsApp Cloud API integration                             | Active                               |
| [D-46](./D-46.md)   | The teacher's own template drives AI compose                          | Active                               |
| [D-52](./D-52.md)   | Shared key-based i18n catalog with a ratchet and a lint rule          | Active                               |
| [D-53](./D-53.md)   | Availability rules frozen in the zone they were written in            | Active                               |
| [D-55](./D-55.md)   | Admin capability layer + an interactive `/admin/uat` runbook          | Active                               |
| [D-56](./D-56.md)   | `/sign-in` never auto-provisions a Teacher                            | Active                               |
| [D-70](./D-70.md)   | Full exit from Supabase and Vercel; history squashed                  | Executed — see D-70                  |
| [D-72](./D-72.md)   | One registry, `target_language` as BCP-47                             | Active (positioning → D-173)         |
| [D-73](./D-73.md)   | Self-hosted teacher intro video + AI intro coach                      | Active (model choice → D-87)         |
| [D-78](./D-78.md)   | Teacher-configurable AI material style                                | Active                               |
| [D-79](./D-79.md)   | Webhook durability: claim completion + a paid-fan-out reconcile       | Active                               |
| [D-80](./D-80.md)   | Vocabulary difficulty separated from CEFR level                       | Active                               |
| [D-81](./D-81.md)   | A third UI language on a registry-driven architecture                 | Active                               |
| [D-83](./D-83.md)   | Teacher → student invitation and onboarding flow                      | Active                               |
| [D-87](./D-87.md)   | Model defaults split by call shape; `effort` and Haiku never coexist  | Active                               |
| [D-88](./D-88.md)   | One-to-one is an always-on prompt directive                           | Active                               |
| [D-93](./D-93.md)   | Homework review / feedback / AI-assist architecture                   | Designed; shipping in slices         |
| [D-94](./D-94.md)   | Production onto the self-hosted LiveKit box                           | First half reversed → D-182          |
| [D-97](./D-97.md)   | Flashcards, speaking-time analytics, derived-offset bookmarks         | Active                               |
| [D-104](./D-104.md) | Public listing gates on Marketplace Ready                             | Active                               |
| [D-106](./D-106.md) | Captions move to a server-side LiveKit agent                          | Superseded by D-185                  |
| [D-107](./D-107.md) | Materials opens on a level picker                                     | Active                               |
| [D-108](./D-108.md) | The captions agent ships from a checkout on the box                   | Superseded by D-185                  |
| [D-110](./D-110.md) | One board in `hq`; this repository carries no backlog                 | Active (location → D-172)            |
| [D-112](./D-112.md) | Teaching language asked at onboarding                                 | Active                               |
| [D-114](./D-114.md) | Recording and transcription off; the capture bug it exposed           | Reversed by D-131                    |
| [D-115](./D-115.md) | Hourly cron grid + a delayed-event wake chain                         | Active                               |
| [D-122](./D-122.md) | Responsive scale moves above every tablet width                       | Superseded by D-141                  |
| [D-123](./D-123.md) | Social previews on the share link; we render every character          | Active (billing path → D-127)        |
| [D-125](./D-125.md) | A student-acquisition assistant with a pure planner                   | Active                               |
| [D-127](./D-127.md) | Image generation moves to Vertex AI                                   | Active (key → runtime identity)      |
| [D-128](./D-128.md) | UK GDPR privacy layer; the supplier register becomes code             | Active                               |
| [D-131](./D-131.md) | Recording and transcription back on; the policy corrected             | Reversed by D-187                    |
| [D-132](./D-132.md) | A teacher setting that auto-starts recording                          | Active                               |
| [D-133](./D-133.md) | Keep the name; withdraw the market premise behind it                  | Superseded (naming) by D-138         |
| [D-134](./D-134.md) | The media host goes behind Cloudflare's proxy                         | Active (partly → D-139)              |
| [D-135](./D-135.md) | The class recording is audio-only                                     | Active                               |
| [D-136](./D-136.md) | Closing an account destroys its recordings                            | Active                               |
| [D-138](./D-138.md) | Renamed to SpiralClass; 45 identifiers deliberately not renamed       | Active                               |
| [D-139](./D-139.md) | Delete the OpenTofu modules that were never applied                   | Active (one part → D-184)            |
| [D-140](./D-140.md) | Legibility is the governing constraint                                | Active                               |
| [D-141](./D-141.md) | The standard breakpoint scale is restored                             | Active                               |
| [D-142](./D-142.md) | The public demo is a rendered fixture                                 | Active (premise revised 2026-10-14)  |
| [D-143](./D-143.md) | The teacher becomes merchant of record                                | Active                               |
| [D-145](./D-145.md) | The manual bank-account rail is removed; Wise stays                   | Active                               |
| [D-147](./D-147.md) | Regulatory position                                                   | Content removed; finding kept        |
| [D-149](./D-149.md) | Group classes: one booking, many attendees                            | Scoped; narrowed by D-149 for two    |
| [D-151](./D-151.md) | Verified student testimonials the teacher cannot write                | Active                               |
| [D-153](./D-153.md) | Money columns say `minor_units`                                       | Active                               |
| [D-155](./D-155.md) | A community has rules, a post and a picture                           | Active                               |
| [D-157](./D-157.md) | Actions comes back; the registry stays the single definition          | Active (heavy tier → D-157)          |
| [D-158](./D-158.md) | Publish the shape, never the account                                  | Active                               |
| [D-159](./D-159.md) | Publish what was built, not the operator's position                   | Active                               |
| [D-163](./D-163.md) | One home for a deploy value — mechanism reversed by its own addendum  | Active                               |
| [D-164](./D-164.md) | Dead runbooks are deleted, not banner-ed                              | Active                               |
| [D-170](./D-170.md) | The Codespaces path is deleted, not repaired                          | Active                               |
| [D-172](./D-172.md) | The backlog is this repository's Issues, not a private board          | Active                               |
| [D-173](./D-173.md) | Any subject in the copy; the schema stays language-shaped             | Active                               |
| [D-175](./D-175.md) | Tenant scoping is checked by a parser, not by a reader                | Active                               |
| [D-178](./D-178.md) | Migrations expand; contracts ship a release later, marked CONTRACT    | Active                               |
| [D-179](./D-179.md) | CodeQL scans every PR; main refuses a merge that adds an alert        | Active                               |
| [D-181](./D-181.md) | A security fix is a public PR, neutral title, pushed when it can ship | Active                               |
| [D-182](./D-182.md) | Production video back on LiveKit Cloud, the box having no capacity    | Reversed by D-187                    |
| [D-184](./D-184.md) | Cloud Run serves production; Fly is retired                           | Active (revisits D-184's premise)    |
| [D-185](./D-185.md) | Live captions run in the browsers; a computer covers a phone          | Active (supersedes D-106, D-108)     |
| [D-187](./D-187.md) | Video on a free e2-micro; recording and transcription off again       | Active (transcription → D-189)       |
| [D-189](./D-189.md) | The transcript is the browsers' caption text; no audio is captured    | Active (partly reverses D-187)       |
| [D-193](./D-193.md) | One URL per language on public pages; bare URL is English             | Active                               |
| [D-194](./D-194.md) | The booking page's language is the teacher's; no visitor switch       | Active (records existing behaviour)  |
| [D-195](./D-195.md) | One locale per language; a regional locale is a delta over its base   | Decided, not built                   |
| [D-196](./D-196.md) | Legal text: a person translates, English controls, launch needs it    | Partly built                         |
| [D-198](./D-198.md) | Captions show words as spoken; the translation replaces them          | Active (narrows D-27, D-185)         |
| [D-199](./D-199.md) | A merge starts its own production deploy, behind the approval         | Active (narrows D-157)               |
| [D-202](./D-202.md) | One record per live decision, edited in place                         | Active                               |

---

## Retired numbers

A number whose record was absorbed into a live one, or dropped because what it
held was behaviour or a rule, is listed here with where its reasoning went
([D-202](./D-202.md)). A retired number is never reused, and a row is never
removed: applied migrations cite some of these and cannot be edited. Outside
migrations, cite the live record instead.

| #     | Where its reasoning went                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01  | [D-143](./D-143.md) — Payment processor moved from Mercado Pago to Stripe Connect, each teacher paid into her own Stripe account                                                                        |
| D-02  | retired: OXXO cash vouchers were removed for slow settlement; OXXO now appears through the teacher's own Stripe account                                                                                 |
| D-03  | [packages](../features/packages.md) — Removed recurring monthly student subscriptions in favour of one-off packages                                                                                     |
| D-08  | [scheduling](../features/scheduling-booking.md) — The reschedule cap became a pooled per-package schedule-change budget                                                                                 |
| D-09  | [packages](../features/packages.md) — Several packages are consumed FIFO by expiry through one credit ledger                                                                                            |
| D-11  | [D-178](./D-178.md) — Migrations applied by hand, never by a deploy (reversed within weeks)                                                                                                             |
| D-12  | [scheduling](../features/scheduling-booking.md) — Classes complete at their end time; no-show is the only manual label                                                                                  |
| D-14  | [student management](../features/student-management.md) — Teacher-private student notes live in their own table, never in the audit trail                                                               |
| D-15  | [classes and lesson content](../features/classes-lesson-content.md) — Live-notes student visibility is a class window; writing free, live surfaces Pro                                                  |
| D-18  | [D-178](./D-178.md) — Production migrations re-coupled to the deploy after code shipped ahead of its schema                                                                                             |
| D-26  | [D-199](./D-199.md) — `main` stopped deploying to production; a gated promote fast-forwards `production`, which is rebuilt, not artifact-promoted                                                       |
| D-30  | [packages](../features/packages.md) — A single class is sold as a one-class package, paid at reservation and auto-booked on payment                                                                     |
| D-37  | [referrals and discounts](../features/referrals-discounts.md) — Discount codes are the single, teacher-funded reward primitive for referrals, with no credit ledger                                     |
| D-43  | retired: renamed staging to preview; the Inngest re-sync rule is held by `apps/web/tests/inngest/app-id.test.ts`                                                                                        |
| D-44  | [messaging-chat](../features/messaging-chat.md) — Chat drops Supabase Realtime for ~4 s visibility polling; chat notifications go push-first, then email after 3 min only if the thread is still unread |
| D-48  | retired: PostHog region is one env knob, single source `apps/web/src/lib/analytics/posthog-region.ts`, held by `posthog-region.test.ts`                                                                 |
| D-49  | [D-70](./D-70.md) — Database provisioning, schema and data movement as three reproducible, provider-neutral layers; tooling built ahead of need                                                         |
| D-50  | [D-143](./D-143.md) — Capture the billing address at checkout; Stripe Tax stays behind an off-by-default flag                                                                                           |
| D-51  | [D-70](./D-70.md) — The multi-region serving plane (pooling, routing, config, residency audit) designed and deliberately not built                                                                      |
| D-58  | [D-143](./D-143.md) — Platform Stripe entity moved to the UK; the Connect gate widened to the cross-border payout circle                                                                                |
| D-64  | [D-153](./D-153.md) — Teacher-chosen pricing currency, captured once at onboarding from a curated list                                                                                                  |
| D-65  | [D-70](./D-70.md) — R2 buckets split preview/production with their own tokens; bucket list corrected; one env-prefix map reads every bucket                                                             |
| D-66  | [D-70](./D-70.md) — Infisical replaces a hand-pasted plaintext secrets file; values travel on stdin, never argv                                                                                         |
| D-69  | [library materials](../features/library-materials.md) — ClassContent and ClassMaterial merged into LibraryMaterial                                                                                      |
| D-75  | [live-calls-video](../features/live-calls-video.md) — A waiting-room Nudge on demand instead of auto-ringing a scheduled class                                                                          |
| D-76  | retired: maintenance mode is an env flag — reasons in `apps/web/src/lib/maintenance.ts`, procedure in `docs/deployment/RELEASE_AND_STAGING.md`                                                          |
| D-85  | [D-70](./D-70.md) — Non-secret config leaves `fly.<env>.toml` for platform-neutral `config/env/` files                                                                                                  |
| D-86  | [admin portal](../features/admin-portal.md) — Admin unit-economics estimate layer: pricing as data, a GBP view, estimates never mixed with actuals                                                      |
| D-89  | [D-70](./D-70.md) — Production cut over to Fly + Neon; Phase 5 tore down Vercel and Supabase and removed the code coupling                                                                              |
| D-95  | [D-178](./D-178.md) — Neon PITR plus a pre-migration checkpoint branch replaced the pg_dump-to-R2 deploy gate                                                                                           |
| D-96  | [subscriptions](../features/subscriptions.md) — Kept code-defined plans and one entitlements resolver; closed the enforcement gaps                                                                      |
| D-99  | [D-153](./D-153.md) — Platform subscription billing currency moved from MXN to GBP                                                                                                                      |
| D-111 | [packages](../features/packages.md) — A package buyer may pick the first class before paying; no sessionless booking                                                                                    |
| D-113 | [D-145](./D-145.md) — Manual rail made generic: the payee instrument is data, not a payment provider                                                                                                    |
| D-116 | [D-157](./D-157.md) — Retired the no-local-tests policy once the 8GB laptop was replaced                                                                                                                |
| D-119 | [D-157](./D-157.md) — CI moved onto the laptop: `steps.mjs` registry, pre-push gate, `local-gate` status                                                                                                |
| D-120 | [D-199](./D-199.md) — The web deploy left Actions and was chained into `pnpm promote`, so a release cannot be forgotten                                                                                 |
| D-124 | [D-145](./D-145.md) — Bank-account instrument backed by a 15-scheme per-country registry                                                                                                                |
| D-129 | [D-157](./D-157.md) — Every workflow deleted; crons became hand-run commands with a staleness nag; no scheduled backup                                                                                  |
| D-137 | [D-143](./D-143.md) — The platform never collects and forwards student money; teacher-held card links were in scope                                                                                     |
| D-144 | [D-143](./D-143.md) — Student checkout stopped requiring a full address; buy page reordered around the buyer                                                                                            |
| D-146 | [D-157](./D-157.md) — Machine lock, fast tier at push, one shared turbo cache                                                                                                                           |
| D-150 | [D-184](./D-184.md) — Hosting decided by measured latency; the web app briefly bound for Oracle, the database kept on managed Neon                                                                      |
| D-152 | [D-143](./D-143.md) — The teacher is told Stripe's fee is Stripe's; public copy quotes no percentage                                                                                                    |
| D-160 | [D-157](./D-157.md) — The gate runs the shared packages' suites, selected by path                                                                                                                       |
| D-161 | [D-157](./D-157.md) — Heavy tier moved to runners via Linux visual baselines                                                                                                                            |
| D-162 | [D-157](./D-157.md) — `pnpm ship-pr` deleted; the runners' push runs certify a release                                                                                                                  |
| D-168 | [D-178](./D-178.md) — Migration history squashed to two files: a generated baseline and hand-written invariants                                                                                         |
| D-169 | [D-163](./D-163.md) — One wrapper (`infra/infisical/infisical.sh`) owns every Infisical CLI call                                                                                                        |
| D-171 | [D-157](./D-157.md) — One visual baseline set, `-linux.png`, asserted only on `ubuntu-latest`                                                                                                           |
| D-174 | retired: one `revalidateAfterAction` per action — reasons and measurements in `apps/web/src/lib/revalidate.ts`, held by `revalidate-once.test.ts`                                                       |
| D-176 | [D-175](./D-175.md) — The tenant a request is entitled to is carried from the auth gate to a runtime Prisma extension                                                                                   |
| D-177 | [D-70](./D-70.md) — Vercel returned as a no-domain production failover; the coupling stayed removed                                                                                                     |
| D-180 | retired: front-door counts that every PR moves are stated as floors; the rule is in `scripts/readme-counts.mjs`                                                                                         |
| D-183 | [D-184](./D-184.md) — The Oracle tenancy went Pay As You Go for capacity priority; Always Free ceilings now bill                                                                                        |
| D-186 | [D-70](./D-70.md) — The Vercel failover was retired; Cloud Run is the only target; coupling bans stay                                                                                                   |
| D-188 | [D-149](./D-149.md) — Packages for two: one buyer, one account, its own credit balance                                                                                                                  |
| D-190 | [D-184](./D-184.md) — A wedged Cloud Run instance is restarted by a liveness probe on the DB-free health route                                                                                          |
| D-191 | [payments](../features/payments.md) — Money screens lead with what was earned this month, not a "safe to spend" average                                                                                 |
| D-192 | [admin portal](../features/admin-portal.md) — Operator test accounts are flagged and left out of every figure                                                                                           |
| D-197 | [D-153](./D-153.md) — Prices are written in the reader's number format; the currency never changes                                                                                                      |
| D-200 | [D-199](./D-199.md) — Preview returns as a second Cloud Run service deployed by every merge (decided, not built)                                                                                        |

---

## Adding one

**Most changes do not need a record.** One is warranted only when there were at
least two real options, a wrong choice is expensive or hard to undo, and someone
could plausibly undo it without knowing why. Otherwise the reasoning goes in the
PR body, behaviour in [`docs/features/`](../features/), and the constraint in a
guard test.

**If a record for the topic exists, amend it** — rewrite what is now true and
add the change to its How we got here section, saying what changed about the
premise. Only a new topic gets a new number: copy
[`_template.md`](./_template.md) to the next unused number (never a retired
one), and add a row to both the theme table and the numeric index above.
