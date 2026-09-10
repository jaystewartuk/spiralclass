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
- **A superseded decision stays and is marked, never deleted.** Where a later
  decision reverses an earlier one, both are here and the header says which is
  live. The reasoning trail is the point, so a reversal is recorded rather than
  resolved by removing what it reversed.
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
  four times before [D-119](./D-119.md) put it on a laptop and
  [D-157](./D-157.md) put it back on runners; three OpenTofu modules were
  written and never applied. The surviving arc is
  D-119 → [D-129](./D-129.md) → D-157 → [D-161](./D-161.md) →
  [D-162](./D-162.md), plus [D-139](./D-139.md) and [D-164](./D-164.md), which
  are the two records that state what the churn actually taught.
- **16 — implementation notes and superseded product detail.** A bug-fix pass,
  a settings-page CRUD manager, a feature shipped with no rejected
  alternative, a product surface that was built, retired and then deleted
  outright together with the record of its retirement, and decisions whose
  successor tells the whole story better (phone-OTP sign-in and device trust,
  both reversed by [D-40](./D-40.md)).

**Numbering is never reused and never renumbered**, so `D-01` is still the
first decision and `D-177` the most recent. A gap means a record was removed,
not that one is missing.

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
  `Transfer` to a Mexican account) instead of isolating it. The fix was not to
  route around the payout circle but to stop needing one. Three addenda record
  what only appeared once a real teacher onboarded, including the fact that a
  connected account, once created, **can never be deleted**.
- **[D-129](./D-129.md)** — every GitHub Actions workflow in the repository is
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
- **[D-150](./D-150.md)** — round-trip latency measured from the actual
  machines, then multiplied by a documented query pattern: moving the app to a
  free box would cost ~1.3 seconds on a database-heavy page. The free option
  loses, and the record says so.

### Something found, and then fixed

- **[D-136](./D-136.md)** — the published retention table promised that closing
  an account destroys its recordings, and the code did not do it. This is the
  change that makes the sentence true, not a new policy.
- **[D-160](./D-160.md)** — 1,265 tests in the shared packages were run by no
  step in the gate's registry. Adding one found a timezone defect that every
  UTC machine agreed was correct.

- **[D-140](./D-140.md)**'s correction — three guards were watching the type
  scale and none fired, because each derived its bound from the thing it was
  guarding. A test that asserts every step is at least as large as the smallest
  step certifies the exact violation it exists to catch.

### Where the money goes, and where it deliberately does not

- **[D-137](./D-137.md)** — "the platform never touches the funds" is promoted
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

| #                   | Decision                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- |
| [D-01](./D-01.md)   | Payment processor: Mercado Pago → Stripe                                                     |
| [D-02](./D-02.md)   | Cash-voucher (OXXO) rail removed — asynchronous settlement broke booking confirmation        |
| [D-03](./D-03.md)   | Recurring subscriptions removed; one-off packages only                                       |
| [D-30](./D-30.md)   | Individual classes sold and paid for at reservation, on the existing package machinery       |
| [D-37](./D-37.md)   | Discount codes are the single reward primitive for referrals — teacher-funded, no ledger     |
| [D-50](./D-50.md)   | Capture the billing address now, enable tax later — it cannot be added retroactively         |
| [D-58](./D-58.md)   | Platform entity MX → UK; the Connect country gate becomes the cross-border payout circle     |
| [D-64](./D-64.md)   | Teacher-selectable pricing currency, split by payout rail                                    |
| [D-79](./D-79.md)   | Webhook durability: a claim recorded before the handler ran swallowed Stripe's retries       |
| [D-99](./D-99.md)   | Platform billing MXN → GBP, and the currency-blending bugs the audit found on the way        |
| [D-113](./D-113.md) | Generalise the manual rail rather than adding a per-country sibling                          |
| [D-124](./D-124.md) | Any country, via a 15-scheme payee registry with real checksums — no free-form payee field   |
| [D-137](./D-137.md) | The platform stays out of the money flow; a card rail outside the circle is the teacher's    |
| [D-143](./D-143.md) | **The teacher becomes merchant of record — Connect direct charges on Accounts v2**           |
| [D-144](./D-144.md) | Checkout stops collecting an address it has no use for, and is reordered around the decision |
| [D-145](./D-145.md) | The manual bank-account rail is removed once Stripe began presenting SPEI itself             |
| [D-152](./D-152.md) | Tell the teacher what Stripe charges her, and that the platform receives none of it          |
| [D-153](./D-153.md) | Money columns say `minor_units` — eight supported currencies have no minor unit              |

### Scheduling, packages and credits

Where correctness is bought with database constraints rather than
application-level checking — a partial unique index and two `EXCLUDE`
constraints, not a pre-flight check — and where two defaults were reversed once
someone worked out what they actually cost a student.

| #                   | Decision                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| [D-08](./D-08.md)   | The reschedule cap moves to a per-package budget — the per-booking one was trivially dodged    |
| [D-09](./D-09.md)   | **Credits are drawn soonest-to-expire first**, server-side, not newest-first by the client     |
| [D-12](./D-12.md)   | Classes complete at their end time; "no-show" is the only manual divergence                    |
| [D-53](./D-53.md)   | Each availability rule is frozen in the zone it was written in                                 |
| [D-111](./D-111.md) | Package guest booking is "pick your first class" — full guest booking needs a third auth state |
| [D-149](./D-149.md) | Group classes are one booking with many attendees, because the exclusion constraint says so    |

### Identity, authentication and access

A student can belong to several teachers, which is the single most consequential
modelling decision in the product and shapes every query in the student tree.

| #                   | Decision                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| [D-25](./D-25.md)   | Superadmin hardened: mandatory MFA, append-only audit at the database, attributed impersonation           |
| [D-38](./D-38.md)   | Teacher and Student are mutually exclusive per auth identity — a payee is not a payer                     |
| [D-40](./D-40.md)   | **Replace Supabase Auth with better-auth on our own tables** — auth travels with the database             |
| [D-55](./D-55.md)   | An admin capability layer beneath the rank ladder, and a runbook that is a page, not a doc                |
| [D-56](./D-56.md)   | `/sign-in` never auto-provisions a teacher; intent comes from the page, never from a miss                 |
| [D-83](./D-83.md)   | Teacher → student invitations: hashed tokens, one pending per pair, idempotent acceptance                 |
| [D-104](./D-104.md) | Public listing gates on Marketplace Ready, not on having submitted the wizard                             |
| [D-175](./D-175.md) | **Tenant scoping is checked by a parser, not by a reader** — a ratchet, and five decoys it fails          |
| [D-176](./D-176.md) | **The tenant a request is entitled to is carried, not inferred** — the query cannot supply its own answer |

### Video and real time

Owning the call was never about the call. It was about owning the media the
lesson-AI pipeline needs — and about being able to overlay the teacher's notes
on it.

| #                   | Decision                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| [D-16](./D-16.md)   | **A `VideoProvider` seam** — the Cloud → self-hosted move changed two config values        |
| [D-27](./D-27.md)   | Live captions, client-streamed and ephemeral, because serverless cannot host a worker      |
| [D-94](./D-94.md)   | Production cuts over to the self-hosted LiveKit box — an explicit risk acceptance          |
| [D-106](./D-106.md) | Captions move to a server-side agent once the constraint behind D-27 stopped being true    |
| [D-108](./D-108.md) | The agent ships from a real checkout on the box — the outage was provenance, not the bug   |
| [D-132](./D-132.md) | Auto-start recording when both parties are present — who starts it, never what it captures |
| [D-134](./D-134.md) | The media host goes behind Cloudflare's proxy, after one teacher's iPhone could not join   |
| [D-135](./D-135.md) | Recording becomes audio-only: the first real class produced an 846 MB file                 |

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

| #                   | Decision                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- |
| [D-14](./D-14.md)   | Teacher-private notes get their own table and never enter the audit trail                    |
| [D-15](./D-15.md)   | Note visibility is a time window derived from the booking, not a toggle someone can forget   |
| [D-17](./D-17.md)   | Native structured content, not distributed PDFs; AI authoring in-house and Pro-gated         |
| [D-20](./D-20.md)   | **Inputs are teacher-owned seeded rows, not a platform curriculum library**                  |
| [D-46](./D-46.md)   | A teacher's own lesson template drives AI compose — wire the primitive, don't bake a method  |
| [D-69](./D-69.md)   | `ClassContent` + `ClassMaterial` collapse into `LibraryMaterial` behind two nullable columns |
| [D-78](./D-78.md)   | Account-level AI style as presets plus a bounded note — never a raw editable system prompt   |
| [D-80](./D-80.md)   | Vocabulary difficulty is its own axis; CEFR level was doing double duty as a rarity dial     |
| [D-93](./D-93.md)   | Homework review and AI-assist architecture — designed first, then built in slices            |
| [D-107](./D-107.md) | Materials opens on a level picker: level is the only mandatory, single-valued, ordered axis  |

### Notifications and messaging

| #                 | Decision                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| [D-44](./D-44.md) | Drop Realtime for portable polling; push-first with a delayed email only if still unread |
| [D-75](./D-75.md) | A waiting-room nudge on demand, rather than auto-ringing a scheduled appointment         |

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
| [D-142](./D-142.md) | The public demo is a rendered fixture: a read-only account would need 68 enforcement points           |
| [D-151](./D-151.md) | A testimonial the teacher cannot write — a CHECK constraint ties the badge to a real student          |
| [D-155](./D-155.md) | The generated memes were all a shocked face because our own prompt asked for one                      |

### Language, i18n and copy

A teacher has four independent language fields and conflating any two of them
has broken production.

| #                   | Decision                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| [D-52](./D-52.md)   | One shared key-based catalog, completeness as a type error, plus a ratchet and a lint rule |
| [D-72](./D-72.md)   | One 234-entry registry from CLDR; language-first framing widened by D-173                  |
| [D-81](./D-81.md)   | A third UI language, on a registry where adding one is two steps                           |
| [D-112](./D-112.md) | Ask for the teaching language at onboarding — an unset value silently seeds the wrong pack |
| [D-173](./D-173.md) | Teachers of **any subject** — the copy widened, the language-shaped schema did not         |

### Design and layout

| #                   | Decision                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| [D-122](./D-122.md) | A tablet is a phone with more room — the scale moves above every tablet width                  |
| [D-140](./D-140.md) | **Legibility outranks identity**, and the correction where the stated floor was never held     |
| [D-141](./D-141.md) | The standard scale is restored; the touch question moves to `pointer: coarse` where it belongs |

### Subscriptions, entitlements and unit economics

| #                 | Decision                                                                                |
| ----------------- | --------------------------------------------------------------------------------------- |
| [D-86](./D-86.md) | Pricing is data, not code — a generic engine with no per-provider branches              |
| [D-96](./D-96.md) | The entitlements audit changes no architecture: the gaps were in applying it, not in it |

### Database, hosting and configuration

The three-layer thesis — provision, schema, data — written before it was needed
and exercised for real when the provider actually changed.

| #                   | Decision                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| [D-11](./D-11.md)   | Migrations are applied by hand, never by a deploy                                                            |
| [D-18](./D-18.md)   | …and re-coupled, because the named risk bit: code shipped ahead of its schema                                |
| [D-26](./D-26.md)   | A staging tier and a gated promote — `main` stops deploying to production                                    |
| [D-43](./D-43.md)   | Rename staging → preview, and the two silent outages the rename actually caused                              |
| [D-49](./D-49.md)   | **Provision · schema · data as three independently reproducible layers**                                     |
| [D-51](./D-51.md)   | The serving plane is designed and deliberately **not** built — these layers change the hot path              |
| [D-65](./D-65.md)   | IaC written without live API access got the bucket list wrong; preview and production split                  |
| [D-66](./D-66.md)   | A managed secrets store replaces a plaintext file nobody rotates                                             |
| [D-70](./D-70.md)   | **Full exit from Supabase and Vercel**; 125 migrations squashed to one portable baseline                     |
| [D-76](./D-76.md)   | Maintenance mode is an env var, because a flag you cannot read while the database is down is useless         |
| [D-85](./D-85.md)   | Non-secret config leaves the host's own format — split on one question: is this a credential?                |
| [D-89](./D-89.md)   | The cutover, executed — and the decommission that removed the code coupling                                  |
| [D-95](./D-95.md)   | Neon PITR plus a named pre-migration checkpoint branch replaces a dump that gated every deploy               |
| [D-115](./D-115.md) | Collapse the cron wake grid; serve the tight leg with a delayed-event chain                                  |
| [D-127](./D-127.md) | Image generation moves to Vertex AI — the consumer API gates on a prepay balance                             |
| [D-139](./D-139.md) | **Delete the OpenTofu modules that were never applied** — they assert a state nobody reconciled              |
| [D-150](./D-150.md) | Measure the latency before taking the free box, and keep the database where it is                            |
| [D-168](./D-168.md) | **46 migrations become two**, split by who writes them — generated baseline, hand-authored invariants        |
| [D-169](./D-169.md) | **One wrapper owns every Infisical call**, and deployment does not make one — it reads pushed GitHub secrets |
| [D-170](./D-170.md) | The Codespaces path is **deleted rather than repaired** — a development path with no users is not a feature  |
| [D-177](./D-177.md) | **Vercel returns as a second production target that holds no domain** — the target, not the coupling         |

### CI, the gate and releasing

One registry defines what "green" means. Everything else — a laptop, a runner,
a hook — is a caller.

| #                   | Decision                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| [D-116](./D-116.md) | Retire the no-local-tests policy once both its premises were gone                              |
| [D-119](./D-119.md) | **`scripts/ci/steps.mjs` becomes the single definition of green**, run by the pre-push hook    |
| [D-120](./D-120.md) | The deploy leaves Actions, measured: ~744 billable minutes a month against a 2,000 allowance   |
| [D-129](./D-129.md) | Every workflow is deleted after the allowance emptied and a backup silently stopped            |
| [D-146](./D-146.md) | One heavy job at a time — the shared test database and port 3000 corrupt rather than queue     |
| [D-157](./D-157.md) | **Actions comes back on one condition**: the workflows call the registry and restate nothing   |
| [D-160](./D-160.md) | A suite no step in the registry runs is a suite that is not run                                |
| [D-161](./D-161.md) | The heavy tier moves to runners — two platform-suffixed baseline sets, not a widened threshold |
| [D-162](./D-162.md) | The runners certify the release; a local receipt was a self-attestation                        |
| [D-163](./D-163.md) | One home for a deploy value — and the same-day reversal of the mechanism, with the reason      |
| [D-164](./D-164.md) | **A runbook for infrastructure that does not exist is deleted, not banner-ed**                 |
| [D-171](./D-171.md) | One visual baseline set, owned by the machine that gates the merge — the macOS half is deleted |

### Privacy, governance and publication

| #                   | Decision                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [D-05](./D-05.md)   | _(tombstone)_ An early privacy framing, superseded by D-128 and removed before publication                           |
| [D-48](./D-48.md)   | **A setting is only configuration if every consumer reads the config** — one hardcoded reader makes it a code change |
| [D-110](./D-110.md) | One board, off this repository: 100 documents that were really queues of work are deleted                            |
| [D-172](./D-172.md) | The board moves into this repository's Issues — the queue stays out of the tree, and stops being private             |
| [D-174](./D-174.md) | **A server action revalidates exactly one path** — a second call makes the client discard the whole response         |
| [D-128](./D-128.md) | The privacy layer becomes UK GDPR, and **the supplier register becomes code with a guard test**                      |
| [D-147](./D-147.md) | _(tombstone)_ The regulatory position, kept privately — with the one engineering finding                             |
| [D-158](./D-158.md) | Publish the shape, never the account — a third gate on the credential scanner                                        |
| [D-159](./D-159.md) | What was built is published; what the operator personally owes is not                                                |

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
| [D-01](./D-01.md)   | Payment processor: Mercado Pago → Stripe                              | Active                               |
| [D-02](./D-02.md)   | Cash-voucher (OXXO) rail removed                                      | Active                               |
| [D-03](./D-03.md)   | Recurring subscriptions removed; one-off packages only                | Active                               |
| [D-05](./D-05.md)   | Early privacy framing                                                 | Superseded by D-128; content removed |
| [D-08](./D-08.md)   | Reschedule cap → per-package schedule-change budget                   | Active                               |
| [D-09](./D-09.md)   | Credit consumption is FIFO-by-expiry, server-decided                  | Active                               |
| [D-11](./D-11.md)   | Migrations applied by hand, never by a deploy                         | Superseded by D-18                   |
| [D-12](./D-12.md)   | Classes auto-complete at their end time                               | Active                               |
| [D-14](./D-14.md)   | Teacher-private notes in their own table, never in the audit trail    | Active                               |
| [D-15](./D-15.md)   | Note visibility by class window; live surfaces Pro-gated              | Active                               |
| [D-16](./D-16.md)   | Own the call behind a `VideoProvider` seam                            | Active                               |
| [D-17](./D-17.md)   | Native structured content, not PDFs; AI authoring in-house            | Active (model choice → D-87)         |
| [D-18](./D-18.md)   | Re-couple production migrations to the deploy                         | Active                               |
| [D-19](./D-19.md)   | Lesson insights: async, buy the ML, derive-then-discard               | Active (model choice → D-87)         |
| [D-20](./D-20.md)   | Teacher-owned seeded inputs, not a platform curriculum                | Active (one call → D-72)             |
| [D-21](./D-21.md)   | Keep-on-opt-in retention + the consent model                          | Active                               |
| [D-22](./D-22.md)   | Capture gated on per-student, minor-aware consent                     | Active                               |
| [D-23](./D-23.md)   | Admin sees pipeline status, never voice-derived content               | Active                               |
| [D-24](./D-24.md)   | Acquisition is teacher amplification, not a marketplace               | Active                               |
| [D-25](./D-25.md)   | Superadmin hardened: MFA, append-only audit, impersonation rules      | Active                               |
| [D-26](./D-26.md)   | Staging tier + gated promote-to-production                            | Principle active; mechanism replaced |
| [D-27](./D-27.md)   | Live captions, client-streamed and ephemeral                          | Superseded in part by D-106          |
| [D-30](./D-30.md)   | Individual classes, paid at reservation                               | Active                               |
| [D-37](./D-37.md)   | Discount codes as the single reward primitive                         | Active                               |
| [D-38](./D-38.md)   | Teacher and Student mutually exclusive per identity                   | Active                               |
| [D-40](./D-40.md)   | Supabase Auth → better-auth on owned tables                           | Active                               |
| [D-42](./D-42.md)   | Remove the WhatsApp Cloud API integration                             | Active                               |
| [D-43](./D-43.md)   | Rename staging → preview, and the outages it caused                   | Active                               |
| [D-44](./D-44.md)   | Portable HTTP chat delivery; push-first with delayed email            | Active                               |
| [D-46](./D-46.md)   | The teacher's own template drives AI compose                          | Active                               |
| [D-48](./D-48.md)   | Analytics region becomes real configuration                           | Active                               |
| [D-49](./D-49.md)   | Provider-neutral provision · schema · data                            | Executed by D-70 / D-89              |
| [D-50](./D-50.md)   | Capture billing address now; tax behind a flag                        | Active (capture-only)                |
| [D-51](./D-51.md)   | The multi-region serving plane — design only, deliberately unbuilt    | Design only; not built               |
| [D-52](./D-52.md)   | Shared key-based i18n catalog with a ratchet and a lint rule          | Active                               |
| [D-53](./D-53.md)   | Availability rules frozen in the zone they were written in            | Active                               |
| [D-55](./D-55.md)   | Admin capability layer + an interactive `/admin/uat` runbook          | Active                               |
| [D-56](./D-56.md)   | `/sign-in` never auto-provisions a Teacher                            | Active                               |
| [D-58](./D-58.md)   | Platform entity MX → UK; Connect gate widens to the circle            | Active (circle retired by D-143)     |
| [D-64](./D-64.md)   | Teacher-selectable pricing currency                                   | Active                               |
| [D-65](./D-65.md)   | R2 buckets split preview/production; env reads consolidated           | Active                               |
| [D-66](./D-66.md)   | Infisical replaces a plaintext secrets file                           | Active                               |
| [D-69](./D-69.md)   | `ClassContent`/`ClassMaterial` merge into `LibraryMaterial`           | Active                               |
| [D-70](./D-70.md)   | Full exit from Supabase and Vercel; history squashed                  | Executed — see D-89                  |
| [D-72](./D-72.md)   | One registry, `target_language` as BCP-47                             | Active (positioning → D-173)         |
| [D-73](./D-73.md)   | Self-hosted teacher intro video + AI intro coach                      | Active (model choice → D-87)         |
| [D-75](./D-75.md)   | Waiting-room presence and an on-demand nudge                          | Active (transport replaced)          |
| [D-76](./D-76.md)   | Cross-app maintenance mode behind one env var                         | Active                               |
| [D-78](./D-78.md)   | Teacher-configurable AI material style                                | Active                               |
| [D-79](./D-79.md)   | Webhook durability: claim completion + a paid-fan-out reconcile       | Active                               |
| [D-80](./D-80.md)   | Vocabulary difficulty separated from CEFR level                       | Active                               |
| [D-81](./D-81.md)   | A third UI language on a registry-driven architecture                 | Active                               |
| [D-83](./D-83.md)   | Teacher → student invitation and onboarding flow                      | Active                               |
| [D-85](./D-85.md)   | Non-secret config moves to platform-neutral `config/env/`             | Active                               |
| [D-86](./D-86.md)   | Unit-economics estimates: pricing as data, never per-provider code    | Active                               |
| [D-87](./D-87.md)   | Model defaults split by call shape; `effort` and Haiku never coexist  | Active                               |
| [D-88](./D-88.md)   | One-to-one is an always-on prompt directive                           | Active                               |
| [D-89](./D-89.md)   | Production cutover executed; Vercel and Supabase decommissioned       | Active (Vercel target back → D-177)  |
| [D-93](./D-93.md)   | Homework review / feedback / AI-assist architecture                   | Designed; shipping in slices         |
| [D-94](./D-94.md)   | Production onto the self-hosted LiveKit box                           | Active                               |
| [D-95](./D-95.md)   | Neon PITR + pre-migration checkpoint branches                         | Active                               |
| [D-96](./D-96.md)   | Entitlements audit: no architecture change; close the gaps            | Active                               |
| [D-97](./D-97.md)   | Flashcards, speaking-time analytics, derived-offset bookmarks         | Active                               |
| [D-99](./D-99.md)   | Platform billing currency MXN → GBP                                   | Active                               |
| [D-104](./D-104.md) | Public listing gates on Marketplace Ready                             | Active                               |
| [D-106](./D-106.md) | Captions move to a server-side LiveKit agent                          | Active                               |
| [D-107](./D-107.md) | Materials opens on a level picker                                     | Active                               |
| [D-108](./D-108.md) | The captions agent ships from a checkout on the box                   | Active (interim)                     |
| [D-110](./D-110.md) | One board in `hq`; this repository carries no backlog                 | Active (location → D-172)            |
| [D-111](./D-111.md) | Package guest booking is "pick your first class"                      | Decided; not built                   |
| [D-112](./D-112.md) | Teaching language asked at onboarding                                 | Active                               |
| [D-113](./D-113.md) | Generalise the manual rail rather than adding a sibling               | Built; extended by D-124             |
| [D-114](./D-114.md) | Recording and transcription off; the capture bug it exposed           | Reversed by D-131                    |
| [D-115](./D-115.md) | Hourly cron grid + a delayed-event wake chain                         | Active                               |
| [D-116](./D-116.md) | Retire the no-local-tests policy                                      | Active                               |
| [D-119](./D-119.md) | One check registry; the pre-push hook runs it                         | Active (in part → D-157)             |
| [D-120](./D-120.md) | The web deploy leaves Actions, on measured cost                       | Superseded in part by D-157          |
| [D-122](./D-122.md) | Responsive scale moves above every tablet width                       | Superseded by D-141                  |
| [D-123](./D-123.md) | Social previews on the share link; we render every character          | Active (billing path → D-127)        |
| [D-124](./D-124.md) | Any country, via a per-country bank-scheme registry                   | Active (`bank_account` → D-145)      |
| [D-125](./D-125.md) | A student-acquisition assistant with a pure planner                   | Active                               |
| [D-127](./D-127.md) | Image generation moves to Vertex AI                                   | Active                               |
| [D-128](./D-128.md) | UK GDPR privacy layer; the supplier register becomes code             | Active                               |
| [D-129](./D-129.md) | Every workflow deleted; the laptop runs everything                    | Superseded in part by D-157          |
| [D-131](./D-131.md) | Recording and transcription back on; the policy corrected             | Active                               |
| [D-132](./D-132.md) | A teacher setting that auto-starts recording                          | Active                               |
| [D-133](./D-133.md) | Keep the name; withdraw the market premise behind it                  | Superseded (naming) by D-138         |
| [D-134](./D-134.md) | The media host goes behind Cloudflare's proxy                         | Active (partly → D-139)              |
| [D-135](./D-135.md) | The class recording is audio-only                                     | Active                               |
| [D-136](./D-136.md) | Closing an account destroys its recordings                            | Active                               |
| [D-137](./D-137.md) | The platform stays out of the money flow                              | Active                               |
| [D-138](./D-138.md) | Renamed to SpiralClass; 45 identifiers deliberately not renamed       | Active                               |
| [D-139](./D-139.md) | Delete the OpenTofu modules that were never applied                   | Active (one part → D-150)            |
| [D-140](./D-140.md) | Legibility is the governing constraint                                | Active                               |
| [D-141](./D-141.md) | The standard breakpoint scale is restored                             | Active                               |
| [D-142](./D-142.md) | The public demo is a rendered fixture                                 | Active                               |
| [D-143](./D-143.md) | The teacher becomes merchant of record                                | Active                               |
| [D-144](./D-144.md) | Checkout stops collecting an unused address; reordered                | Active                               |
| [D-145](./D-145.md) | The manual bank-account rail is removed; Wise stays                   | Active                               |
| [D-146](./D-146.md) | One heavy job at a time; the laptop becomes a queue                   | Active (in part → D-157/D-161)       |
| [D-147](./D-147.md) | Regulatory position                                                   | Content removed; finding kept        |
| [D-149](./D-149.md) | Group classes: one booking, many attendees                            | Scoped; not built                    |
| [D-150](./D-150.md) | Hosting measured; the app stays where the database is                 | Decided; partly executed             |
| [D-151](./D-151.md) | Verified student testimonials the teacher cannot write                | Active                               |
| [D-152](./D-152.md) | Disclose Stripe's fee, and that we receive none of it                 | Active                               |
| [D-153](./D-153.md) | Money columns say `minor_units`                                       | Active                               |
| [D-155](./D-155.md) | A community has rules, a post and a picture                           | Active                               |
| [D-157](./D-157.md) | Actions comes back; the registry stays the single definition          | Active (heavy tier → D-161)          |
| [D-158](./D-158.md) | Publish the shape, never the account                                  | Active                               |
| [D-159](./D-159.md) | Publish what was built, not the operator's position                   | Active                               |
| [D-160](./D-160.md) | The gate runs the shared packages' suites                             | Active                               |
| [D-161](./D-161.md) | The heavy tier leaves the laptop; two baseline sets                   | Active (second set → D-171)          |
| [D-162](./D-162.md) | The runners certify the release                                       | Active                               |
| [D-163](./D-163.md) | One home for a deploy value — mechanism reversed by its own addendum  | Active                               |
| [D-164](./D-164.md) | Dead runbooks are deleted, not banner-ed                              | Active                               |
| [D-168](./D-168.md) | Migration history rebaselined into a generated + a hand-authored file | Active                               |
| [D-169](./D-169.md) | One wrapper owns every Infisical call; deploys make none              | Active                               |
| [D-170](./D-170.md) | The Codespaces path is deleted, not repaired                          | Active                               |
| [D-171](./D-171.md) | One visual baseline set, owned by ubuntu-latest                       | Active                               |
| [D-172](./D-172.md) | The backlog is this repository's Issues, not a private board          | Active                               |
| [D-173](./D-173.md) | Any subject in the copy; the schema stays language-shaped             | Active                               |
| [D-174](./D-174.md) | A server action revalidates exactly one path                          | Active                               |
| [D-175](./D-175.md) | Tenant scoping is checked by a parser, not by a reader                | Active                               |
| [D-176](./D-176.md) | The tenant is carried from the auth gate, not taken from the query    | Active                               |
| [D-177](./D-177.md) | Vercel is a second production target; it holds no domain              | Decided; built, never served         |

---

## Adding one

A change significant enough to set or reverse policy gets a record. Copy
[`_template.md`](./_template.md) to the next unused number, fill it in, and add
a row to both the theme table and the numeric index above.

Read the record you are about to reverse first, and say in the new one what
changed about its premise — that is the part the log exists for.
