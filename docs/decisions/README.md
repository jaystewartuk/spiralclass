# Decision records

**Why SpiralClass is shaped the way it is: one record per live decision.**
Each record opens with the decision in its first sentence, then gives the
constraint that forced it, the options that lost and why, what it cost, what a
future change must not do, and a short **How we got here** that keeps every
reversal and every measured number.

This log is **current policy, not history** — before reversing anything a
decision constrains, read its `D-NN.md` first, and amend that record rather
than opening a successor ([D-202](./D-202.md)).

Until October 2026 the log was append-only: 148 records, most of them links in
chains of reversals. Those were folded into the records below, and the
originals are one click away at the
[starting commit](https://github.com/jaystewartuk/spiralclass/tree/1180a397eb16f961c02054920dc1603c77407647/docs/decisions).
Every number that no longer has a file is in [Retired numbers](#retired-numbers)
with where its reasoning went.

---

## How to read this log

**These are working engineering notes, not marketing.** They are written for
whoever picks the code up next. They are blunt, they show their arithmetic, and
they name what is still wrong.

- **The first sentence is the decision**, specific enough to check against the
  code. Where a record and the code disagree, the code wins, and the record is
  meant to say so; if you find one that does not, fix the record.
- **Unresolved risks are stated, not buried.** "What it cost" is where a gap
  that is already known is written down, which is often exactly what a proposed
  change has just rediscovered.
- **How we got here is the reasoning trail.** A decision that reversed an
  earlier one keeps the earlier one there: what it was, what went wrong, and
  what that cost.

**Context on scale.** This was built and operated by one person, with a
handful of real teachers and their students on it. Decisions that would go to
legal, security review or a change-advisory board in a larger organisation were
made by one person, in writing, here.

---

## What is not here

- **51 records were removed before publication**, and their numbers never
  appear anywhere: a second client (a mobile app) and the records that ended
  it, infrastructure churn whose lesson [D-157](./D-157.md) and
  [D-164](./D-164.md) carry, and implementation notes. None answered "why is it
  built this way" about anything that still exists.
- **119 numbers were retired by the consolidation** — absorbed into a live
  record, or dropped because what they held was behaviour (now in
  [`docs/features/`](../features/)) or a rule (now in a guard or a comment).
- **Behaviour is not here.** What a feature does is in `docs/features/`; a
  record says why it is built that way.

Numbering is never reused and never renumbered, so a gap means a number was
removed or retired, not that a record is missing.

---

## Start here

**If you have ten minutes, read [READ-THIS-FIRST.md](./READ-THIS-FIRST.md)** —
two of these decisions told end to end, with what each one cost.

After that, these show judgement under a real constraint, which is the one
thing a log can show that a codebase cannot.

### A decision reversed, and the reason it reversed

- **[D-143](./D-143.md)** — the teacher becomes the merchant of record. The
  payments architecture had absorbed a hard constraint (a UK platform cannot
  `Transfer` outside its payout circle) instead of isolating it. The fix was to
  stop needing the transfer. What only appeared once a real teacher onboarded
  is in its history, including that a connected account, once created, **can
  never be deleted** — after a retry loop created 24 of them for one teacher.
- **[D-157](./D-157.md)** — every GitHub Actions workflow was deleted after the
  allowance emptied mid-month and production's database went eleven days
  without a backup; workflows came back once the repository was public, on
  one condition: they _call_ the check registry and never restate it.
- **[D-140](./D-140.md)** — a bespoke breakpoint scale was withdrawn. Its
  observation was right (a tablet is a touch device) and it answered it in the
  wrong dimension: width cannot tell a 1280px tablet from a 1280px browser
  window. `pointer` can.

### A cost measured before the decision, not asserted after it

- **[D-115](./D-115.md)** — the cron grid was costing about 89 of 100 free
  compute-hours a month with essentially no users, about 72% of it the
  database's idle timer. The reminders keep their exact timing by arming a
  delayed event instead of polling.
- **[D-184](./D-184.md)** — where the app runs was decided by round trips
  measured from the real machines. A later measurement of what Prisma actually
  sends found the earlier estimate about four times too large, and the record
  keeps both.

### Something found, and then fixed

- **[D-22](./D-22.md)** — the published retention table promised that closing
  an account destroys its recordings, and the code did not do it. The fix made
  the sentence true.
- **[D-140](./D-140.md)**'s correction — three guards were watching the type
  scale and none fired, because each derived its bound from the thing it was
  guarding.
- **[D-153](./D-153.md)** — money columns stopped saying `centavos`. Eight
  supported currencies have no hundredth part, and a hardcoded `100` had
  already stored a 20,000 CLP price as 2,000,000.

---

## By theme

### Payments and money

| #                   | Decision                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| [D-143](./D-143.md) | **The teacher is the merchant of record** — direct charges on her own account, nothing taken        |
| [D-145](./D-145.md) | Outside Stripe, a teacher is paid only through a validated payee instrument; Wise is the only kind  |
| [D-153](./D-153.md) | Money is integer minor units in the price's own currency; only the number format follows the reader |
| [D-79](./D-79.md)   | A webhook event counts as handled only once its handler finished; a sweep re-sends lost events      |

### Scheduling, packages and the database

| #                   | Decision                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| [D-53](./D-53.md)   | Each availability rule is frozen in the time zone it was written in                         |
| [D-149](./D-149.md) | A class for more than one person is still one booking; a package can be sold for two        |
| [D-175](./D-175.md) | **Tenant isolation is checked by the application twice** — a parser and a runtime extension |
| [D-178](./D-178.md) | **Migrations run inside the deploy, behind a checkpoint**, so every one must expand only    |

### Identity and access

| #                 | Decision                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| [D-40](./D-40.md) | Authentication is better-auth on our own tables; a sign-in never decides what account to create |
| [D-25](./D-25.md) | Staff access is the strictest bar: mandatory TOTP, step-up, append-only audit, capabilities     |

### Hosting and platform

| #                   | Decision                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------- |
| [D-70](./D-70.md)   | **The application does not know which platform it runs on**                               |
| [D-184](./D-184.md) | Production is one Cloud Run service beside a managed Neon database, chosen by measurement |
| [D-115](./D-115.md) | Every cron fires on `:00`; sub-hourly precision arms a delayed event instead              |
| [D-138](./D-138.md) | The product is SpiralClass; identifiers naming a live resource keep the old name          |

### CI, the gate and releasing

| #                   | Decision                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| [D-157](./D-157.md) | **One registry defines green**; the laptop and the runners run it, no workflow restates it |
| [D-199](./D-199.md) | **A merge starts its own release**; the owner's approval is the only human step            |
| [D-163](./D-163.md) | The secret store pushes every deploy value out; no CI job can read it                      |

### Video, captions and transcripts

| #                   | Decision                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------- |
| [D-16](./D-16.md)   | **The class call is ours**, on LiveKit behind a provider seam, on one free machine, no egress |
| [D-185](./D-185.md) | Captions are recognised in the browsers, and the lesson transcript is that caption text       |

### Teaching content and AI

| #                   | Decision                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| [D-17](./D-17.md)   | **Lesson content is native, drafted from inputs the teacher owns**; no platform curriculum |
| [D-87](./D-87.md)   | Models are chosen per call shape, and a call that passes `effort` never runs on Haiku      |
| [D-201](./D-201.md) | A model call site ships with an eval set; the teacher's verdict on its output is a figure  |

### Acquisition and the public funnel

| #                   | Decision                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| [D-125](./D-125.md) | **A planner that is a pure function** — the teacher posts, no model decides what numbers mean  |
| [D-142](./D-142.md) | The public demo is the real dashboard rendered from a fixture, not a demo account              |
| [D-151](./D-151.md) | A verified testimonial is written by the student, and the database refuses a badge without one |

### Language and design

| #                   | Decision                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------- |
| [D-72](./D-72.md)   | **Four language columns that never stand in for each other**, and one language per public URL |
| [D-140](./D-140.md) | **Legibility outranks identity**; the layout asks the pointer, not the width                  |

### Privacy, publication and this log

| #                   | Decision                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| [D-22](./D-22.md)   | **A student's voice is kept only on recorded consent**, and the privacy promises are code           |
| [D-158](./D-158.md) | The repository publishes the shape and the engineering, never an account or the operator's exposure |
| [D-164](./D-164.md) | Nothing in the tree describes what does not exist; work owed is an issue                            |
| [D-202](./D-202.md) | **One record per live decision, edited in place**; retired numbers are never reused                 |

---

## Every record, by number

| #                   | Decision                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [D-16](./D-16.md)   | The class call is ours, on LiveKit behind a provider seam, self-hosted on one free machine with no egress                                                              |
| [D-17](./D-17.md)   | Lesson content is native Markdown the platform's own model drafts from inputs the teacher owns; the platform writes no curriculum                                      |
| [D-22](./D-22.md)   | A student's voice is kept only on a recorded per-student consent, and the privacy promises are code the tests hold                                                     |
| [D-25](./D-25.md)   | Staff access is the strictest bar on the platform: mandatory TOTP with a per-session step-up, an append-only audit log, and narrow capabilities beside the rank ladder |
| [D-40](./D-40.md)   | Authentication is better-auth on our own Postgres, and a sign-in never decides what kind of account to create                                                          |
| [D-53](./D-53.md)   | Each availability rule is frozen in the time zone it was written in, and a teacher changing her zone does not move it                                                  |
| [D-70](./D-70.md)   | The application does not know which platform it runs on                                                                                                                |
| [D-72](./D-72.md)   | Languages are codes from two registries, held in four columns that never stand in for each other, and each public URL renders one language                             |
| [D-79](./D-79.md)   | A Stripe webhook event counts as handled only once its handler has finished, and an hourly sweep re-sends lost `payment.paid` events                                   |
| [D-87](./D-87.md)   | Anthropic models are chosen per call shape, and a call that passes `effort` never runs on Haiku                                                                        |
| [D-115](./D-115.md) | Every cron fires on minute `:00`, and a job that needs sub-hourly precision arms a delayed event instead                                                               |
| [D-125](./D-125.md) | Student acquisition is an assistant inside the product: it plans and drafts, the teacher posts, and no model decides what the numbers mean                             |
| [D-138](./D-138.md) | The product is SpiralClass, and identifiers that name a live external resource or stored client state keep `agendaprofe`                                               |
| [D-140](./D-140.md) | Legibility outranks visual identity, and the layout asks the pointer, not the width, whether it is drawn for a finger                                                  |
| [D-142](./D-142.md) | The public demo is the real dashboard rendered from a fixture, not a demo account                                                                                      |
| [D-143](./D-143.md) | The teacher is the merchant of record: lesson payments are direct charges on her own Stripe account, and the platform takes nothing at the charge                      |
| [D-145](./D-145.md) | Outside Stripe, a teacher is paid only through a validated payee instrument, and Wise is the only kind                                                                 |
| [D-149](./D-149.md) | A class for more than one person is still one booking: two people share one package, and a group of three or more will share one booking with a row per attendee       |
| [D-151](./D-151.md) | A "Verified student" testimonial is written by the student, never by the teacher, and the database refuses a badge without one                                         |
| [D-153](./D-153.md) | Money is integer minor units in the price's own recorded currency, and only the number format follows the reader                                                       |
| [D-157](./D-157.md) | One registry defines green; the laptop and GitHub's runners both run it, and no workflow restates it                                                                   |
| [D-158](./D-158.md) | The repository is public, so it publishes the shape and the engineering, never an account or the operator's exposure, and security work is gated in the open           |
| [D-163](./D-163.md) | Infisical holds every deploy value and pushes copies out; no CI job can read Infisical                                                                                 |
| [D-164](./D-164.md) | Nothing in the tree describes what does not exist or lists what is not done: dead things are deleted, and work owed is an issue                                        |
| [D-175](./D-175.md) | Tenant isolation is checked by the application twice — a source parser at the gate and a Prisma extension at runtime — not by Postgres row-level security              |
| [D-178](./D-178.md) | Production migrations run inside the deploy, before the new code and behind a Neon checkpoint, so every migration must work with the code already serving              |
| [D-184](./D-184.md) | Production runs on one Cloud Run service in `us-east4`, beside a managed Neon database in `aws-us-east-1`                                                              |
| [D-185](./D-185.md) | Captions are recognised in the participants' browsers, and the lesson transcript is that caption text                                                                  |
| [D-199](./D-199.md) | A merge to `main` starts its own release, and the owner's approval is the only human step                                                                              |
| [D-201](./D-201.md) | A model call site ships with an eval set; verdicts become a figure                                                                                                     |
| [D-202](./D-202.md) | The decision log keeps one record per live decision, edited in place                                                                                                   |

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
| D-05  | [D-158](./D-158.md) — (tombstone) Early privacy-controller framing; content removed before publication as a legal position                                                                              |
| D-08  | [scheduling](../features/scheduling-booking.md) — The reschedule cap became a pooled per-package schedule-change budget                                                                                 |
| D-09  | [packages](../features/packages.md) — Several packages are consumed FIFO by expiry through one credit ledger                                                                                            |
| D-11  | [D-178](./D-178.md) — Migrations applied by hand, never by a deploy (reversed within weeks)                                                                                                             |
| D-12  | [scheduling](../features/scheduling-booking.md) — Classes complete at their end time; no-show is the only manual label                                                                                  |
| D-14  | [student management](../features/student-management.md) — Teacher-private student notes live in their own table, never in the audit trail                                                               |
| D-15  | [classes and lesson content](../features/classes-lesson-content.md) — Live-notes student visibility is a class window; writing free, live surfaces Pro                                                  |
| D-18  | [D-178](./D-178.md) — Production migrations re-coupled to the deploy after code shipped ahead of its schema                                                                                             |
| D-19  | [D-185](./D-185.md) — Lesson insights: post-class, bought ASR and pronunciation, teacher-confirmed, derive-then-discard audio                                                                           |
| D-20  | [D-17](./D-17.md) — Class-content inputs are teacher-owned, seedable data (profile, focus tags, packs, library bodies), not a platform curriculum                                                       |
| D-21  | [D-22](./D-22.md) — Lesson-insights voice data: derive-then-discard by default, teacher opt-in to keep audio, transcription kept behind a flag                                                          |
| D-23  | [D-22](./D-22.md) — Staff see lesson-insights pipeline status, counts and timestamps, never voice-derived content                                                                                       |
| D-24  | [D-125](./D-125.md) — Student acquisition is an in-app teacher-amplification capability (leads, testimonials, funnel), not a marketplace                                                                |
| D-26  | [D-199](./D-199.md) — `main` stopped deploying to production; a gated promote fast-forwards `production`, which is rebuilt, not artifact-promoted                                                       |
| D-27  | [D-185](./D-185.md) — Live captions streamed from the teacher's browser to Deepgram, translated server-side, ephemeral                                                                                  |
| D-30  | [packages](../features/packages.md) — A single class is sold as a one-class package, paid at reservation and auto-booked on payment                                                                     |
| D-37  | [referrals and discounts](../features/referrals-discounts.md) — Discount codes are the single, teacher-funded reward primitive for referrals, with no credit ledger                                     |
| D-38  | [D-40](./D-40.md) — Teacher and Student are mutually exclusive roles per sign-in identity                                                                                                               |
| D-42  | [notifications](../features/notifications.md) — The WhatsApp Cloud API integration was removed; the phone field and plain wa.me links were kept                                                         |
| D-43  | retired: renamed staging to preview; the Inngest re-sync rule is held by `apps/web/tests/inngest/app-id.test.ts`                                                                                        |
| D-44  | [messaging-chat](../features/messaging-chat.md) — Chat drops Supabase Realtime for ~4 s visibility polling; chat notifications go push-first, then email after 3 min only if the thread is still unread |
| D-46  | [D-17](./D-17.md) — A teacher's own lesson template drives AI compose; no seeded method templates                                                                                                       |
| D-48  | retired: PostHog region is one env knob, single source `apps/web/src/lib/analytics/posthog-region.ts`, held by `posthog-region.test.ts`                                                                 |
| D-49  | [D-70](./D-70.md) — Database provisioning, schema and data movement as three reproducible, provider-neutral layers; tooling built ahead of need                                                         |
| D-50  | [D-143](./D-143.md) — Capture the billing address at checkout; Stripe Tax stays behind an off-by-default flag                                                                                           |
| D-51  | [D-70](./D-70.md) — The multi-region serving plane (pooling, routing, config, residency audit) designed and deliberately not built                                                                      |
| D-52  | [D-72](./D-72.md) — One shared key-based i18n catalog, completeness a type error; the literal ratchet became a ban                                                                                      |
| D-55  | [D-25](./D-25.md) — Admin capability layer (tester/engineer roles) and the interactive /admin/uat runbook                                                                                               |
| D-56  | [D-40](./D-40.md) — /sign-in never provisions a teacher; only an explicit sign-up intent does                                                                                                           |
| D-58  | [D-143](./D-143.md) — Platform Stripe entity moved to the UK; the Connect gate widened to the cross-border payout circle                                                                                |
| D-64  | [D-153](./D-153.md) — Teacher-chosen pricing currency, captured once at onboarding from a curated list                                                                                                  |
| D-65  | [D-70](./D-70.md) — R2 buckets split preview/production with their own tokens; bucket list corrected; one env-prefix map reads every bucket                                                             |
| D-66  | [D-70](./D-70.md) — Infisical replaces a hand-pasted plaintext secrets file; values travel on stdin, never argv                                                                                         |
| D-69  | [library materials](../features/library-materials.md) — ClassContent and ClassMaterial merged into LibraryMaterial                                                                                      |
| D-73  | [teacher management](../features/teacher-management.md) — Teacher intro video: a self-hosted public file on the booking page, with a Pro AI coach on its transcript                                     |
| D-75  | [live-calls-video](../features/live-calls-video.md) — A waiting-room Nudge on demand instead of auto-ringing a scheduled class                                                                          |
| D-76  | retired: maintenance mode is an env flag — reasons in `apps/web/src/lib/maintenance.ts`, procedure in `docs/deployment/RELEASE_AND_STAGING.md`                                                          |
| D-78  | [D-17](./D-17.md) — Teacher-configurable AI material style: presets and a note, never an editable raw prompt                                                                                            |
| D-80  | [D-17](./D-17.md) — Vocabulary difficulty is its own axis, separate from the CEFR level                                                                                                                 |
| D-81  | [D-72](./D-72.md) — French as a third UI language; a language is a registry row; "System Default" follows the device                                                                                    |
| D-83  | [student management](../features/student-management.md) — Teacher-to-student invitations: a hashed token per roster student, accepted through existing sign-in                                          |
| D-85  | [D-70](./D-70.md) — Non-secret config leaves `fly.<env>.toml` for platform-neutral `config/env/` files                                                                                                  |
| D-86  | [admin portal](../features/admin-portal.md) — Admin unit-economics estimate layer: pricing as data, a GBP view, estimates never mixed with actuals                                                      |
| D-88  | [D-17](./D-17.md) — Every AI material prompt states a one-to-one lesson, always on, with no setting                                                                                                     |
| D-89  | [D-70](./D-70.md) — Production cut over to Fly + Neon; Phase 5 tore down Vercel and Supabase and removed the code coupling                                                                              |
| D-93  | [homework](../features/homework.md) — Homework review, feedback and AI-review architecture (attempts, feedback, teacher-triggered AI drafts)                                                            |
| D-94  | [D-16](./D-16.md) — Production LiveKit moved onto the self-hosted Oracle box and the gated video flags were turned on (2026-07-21); preview lost its key pair (2026-09-16)                              |
| D-95  | [D-178](./D-178.md) — Neon PITR plus a pre-migration checkpoint branch replaced the pg_dump-to-R2 deploy gate                                                                                           |
| D-96  | [subscriptions](../features/subscriptions.md) — Kept code-defined plans and one entitlements resolver; closed the enforcement gaps                                                                      |
| D-97  | [lesson insights](../features/lesson-insights-reports.md) — Vocabulary flashcards, speaking-time analytics and in-call bookmarks added                                                                  |
| D-99  | [D-153](./D-153.md) — Platform subscription billing currency moved from MXN to GBP                                                                                                                      |
| D-104 | [teacher management](../features/teacher-management.md) — Public listing gates on Marketplace Ready, not on onboarding completion                                                                       |
| D-106 | [D-185](./D-185.md) — Live captions moved to a server-side LiveKit agent on the Oracle box                                                                                                              |
| D-107 | [library materials](../features/library-materials.md) — Materials opens on a level picker, with shelves as views over `levelId`, not folders                                                            |
| D-108 | [D-185](./D-185.md) — The captions agent shipped from a git checkout on the box, SHA-pinned                                                                                                             |
| D-110 | [D-164](./D-164.md) — No queue in the tree; 100 backlog-shaped documents deleted                                                                                                                        |
| D-111 | [packages](../features/packages.md) — A package buyer may pick the first class before paying; no sessionless booking                                                                                    |
| D-112 | [D-72](./D-72.md) — The teaching language is asked at onboarding; per-package Subject leaves the onboarding step                                                                                        |
| D-113 | [D-145](./D-145.md) — Manual rail made generic: the payee instrument is data, not a payment provider                                                                                                    |
| D-114 | [D-185](./D-185.md) — Recording, transcription and podcasts turned off before first promotion; podcasts got their own flag                                                                              |
| D-116 | [D-157](./D-157.md) — Retired the no-local-tests policy once the 8GB laptop was replaced                                                                                                                |
| D-119 | [D-157](./D-157.md) — CI moved onto the laptop: `steps.mjs` registry, pre-push gate, `local-gate` status                                                                                                |
| D-120 | [D-199](./D-199.md) — The web deploy left Actions and was chained into `pnpm promote`, so a release cannot be forgotten                                                                                 |
| D-122 | [D-140](./D-140.md) — Breakpoints moved above every tablet width (withdrawn the same month)                                                                                                             |
| D-123 | [D-125](./D-125.md) — A social-preview image belongs to the share link; the model draws no text, our route renders it                                                                                   |
| D-124 | [D-145](./D-145.md) — Bank-account instrument backed by a 15-scheme per-country registry                                                                                                                |
| D-127 | [D-125](./D-125.md) — Social-preview image generation runs on Vertex AI (postpaid), now as the Cloud Run runtime identity                                                                               |
| D-128 | [D-22](./D-22.md) — The privacy notice became one UK GDPR policy, and the supplier register became code with a guard test                                                                               |
| D-129 | [D-157](./D-157.md) — Every workflow deleted; crons became hand-run commands with a staleness nag; no scheduled backup                                                                                  |
| D-131 | [D-185](./D-185.md) — Recording and transcription turned back on (2026-08-26)                                                                                                                           |
| D-132 | [D-16](./D-16.md) — A teacher setting that auto-starts class recording once both people are in the room                                                                                                 |
| D-133 | [D-138](./D-138.md) — Kept the name AgendaProfe and withdrew the Spanish-market premise for it                                                                                                          |
| D-134 | [D-16](./D-16.md) — `livekit.spiralclass.com` put behind Cloudflare's proxy (2026-08-27)                                                                                                                |
| D-135 | [D-16](./D-16.md) — The class recording became audio-only (2026-08-27)                                                                                                                                  |
| D-136 | [D-22](./D-22.md) — Closing a teacher's account destroys her recordings, audio, transcripts and summaries                                                                                               |
| D-137 | [D-143](./D-143.md) — The platform never collects and forwards student money; teacher-held card links were in scope                                                                                     |
| D-139 | [D-164](./D-164.md) — Deleted the two OpenTofu modules that were never applied                                                                                                                          |
| D-141 | [D-140](./D-140.md) — Tailwind's default breakpoints restored; the shell is gated on `pointer: fine`                                                                                                    |
| D-144 | [D-143](./D-143.md) — Student checkout stopped requiring a full address; buy page reordered around the buyer                                                                                            |
| D-146 | [D-157](./D-157.md) — Machine lock, fast tier at push, one shared turbo cache                                                                                                                           |
| D-147 | [D-158](./D-158.md) — (tombstone) The platform's regulatory position, kept privately; its one engineering finding is in payments                                                                        |
| D-150 | [D-184](./D-184.md) — Hosting decided by measured latency; the web app briefly bound for Oracle, the database kept on managed Neon                                                                      |
| D-152 | [D-143](./D-143.md) — The teacher is told Stripe's fee is Stripe's; public copy quotes no percentage                                                                                                    |
| D-155 | [D-125](./D-125.md) — A community carries rules, a post and a picture; the image brief has three authors                                                                                                |
| D-159 | [D-158](./D-158.md) — The repository publishes what was built, never the operator's legal or financial position                                                                                         |
| D-160 | [D-157](./D-157.md) — The gate runs the shared packages' suites, selected by path                                                                                                                       |
| D-161 | [D-157](./D-157.md) — Heavy tier moved to runners via Linux visual baselines                                                                                                                            |
| D-162 | [D-157](./D-157.md) — `pnpm ship-pr` deleted; the runners' push runs certify a release                                                                                                                  |
| D-168 | [D-178](./D-178.md) — Migration history squashed to two files: a generated baseline and hand-written invariants                                                                                         |
| D-169 | [D-163](./D-163.md) — One wrapper (`infra/infisical/infisical.sh`) owns every Infisical CLI call                                                                                                        |
| D-170 | [D-164](./D-164.md) — The Codespaces dev path was deleted rather than repaired                                                                                                                          |
| D-171 | [D-157](./D-157.md) — One visual baseline set, `-linux.png`, asserted only on `ubuntu-latest`                                                                                                           |
| D-172 | [D-164](./D-164.md) — Work owed is an issue on this repository, not a private board                                                                                                                     |
| D-173 | [D-72](./D-72.md) — The audience is teachers of any subject; the schema stays language-shaped                                                                                                           |
| D-174 | retired: one `revalidateAfterAction` per action — reasons and measurements in `apps/web/src/lib/revalidate.ts`, held by `revalidate-once.test.ts`                                                       |
| D-176 | [D-175](./D-175.md) — The tenant a request is entitled to is carried from the auth gate to a runtime Prisma extension                                                                                   |
| D-177 | [D-70](./D-70.md) — Vercel returned as a no-domain production failover; the coupling stayed removed                                                                                                     |
| D-179 | [D-158](./D-158.md) — CodeQL default setup; main refuses a merge that adds an alert (ruleset, no bypass)                                                                                                |
| D-180 | retired: front-door counts that every PR moves are stated as floors; the rule is in `scripts/readme-counts.mjs`                                                                                         |
| D-181 | [D-158](./D-158.md) — A security fix lands as a public PR with a neutral title, pushed only when it can ship                                                                                            |
| D-182 | [D-16](./D-16.md) — Production video went to LiveKit Cloud while Oracle had no capacity to relaunch the box (2026-09-19)                                                                                |
| D-183 | [D-184](./D-184.md) — The Oracle tenancy went Pay As You Go for capacity priority; Always Free ceilings now bill                                                                                        |
| D-186 | [D-70](./D-70.md) — The Vercel failover was retired; Cloud Run is the only target; coupling bans stay                                                                                                   |
| D-187 | [D-16](./D-16.md) — Production video moved to a free Compute Engine e2-micro; recording and transcription went off because it cannot carry egress (2026-09-24)                                          |
| D-188 | [D-149](./D-149.md) — Packages for two: one buyer, one account, its own credit balance                                                                                                                  |
| D-189 | [D-185](./D-185.md) — The lesson transcript is the caption text the browsers recognise, kept with consent; no audio                                                                                     |
| D-190 | [D-184](./D-184.md) — A wedged Cloud Run instance is restarted by a liveness probe on the DB-free health route                                                                                          |
| D-191 | [payments](../features/payments.md) — Money screens lead with what was earned this month, not a "safe to spend" average                                                                                 |
| D-192 | [admin portal](../features/admin-portal.md) — Operator test accounts are flagged and left out of every figure                                                                                           |
| D-193 | [D-72](./D-72.md) — One URL per language for public pages; the bare URL is English                                                                                                                      |
| D-194 | [D-72](./D-72.md) — A visitor cannot switch a booking page's language; it follows `booking_page_locale`                                                                                                 |
| D-195 | [D-72](./D-72.md) — One locale per language until a region earns one; a regional locale is a delta                                                                                                      |
| D-196 | [D-72](./D-72.md) — Legal text is translated by a person, English controls, no launch without it                                                                                                        |
| D-197 | [D-153](./D-153.md) — Prices are written in the reader's number format; the currency never changes                                                                                                      |
| D-198 | [D-185](./D-185.md) — A caption shows the words as spoken; the translation replaces them when the phrase ends                                                                                           |
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
