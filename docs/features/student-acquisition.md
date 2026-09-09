# Student acquisition

**Consigue alumnos** (Get students) is where a teacher goes to get her next
student. It is a command centre, not a marketing dashboard: it answers one
question, what should I do today, and everything else on the screen is arranged
under that answer.

Decision of record: [D-125](../decisions/D-125.md).

---

## What the teacher sees

- **Today** — the next two prepared actions, each with the reason it was chosen
  written in plain language from a real number ("Oaxaca Expats has already
  brought you 2 students").
- **This week** — the rest of the plan, plus what she has already done or
  skipped, and a control to rebuild the week.
- **Last 30 days** — visits, enquiries and new students, small and at the
  bottom, because this screen is for doing rather than reading.

Three destinations sit one level down: **Comunidades** (where she can reach
learners), **Resultados** (what is actually working), and **Tu perfil** (the four
things the system cannot infer).

---

## The weekly plan

The plan is decided by a pure function, `buildWeeklyPlan` in
`packages/shared/src/marketing/planner.ts`, and is therefore reproducible from
its inputs and unit-tested rather than prompted. It reads:

- **Community results** — visits, enquiries and students attributed to each
  community over the last 120 days.
- **Recency** — when she last posted to each community, with a five-day cooldown
  per community and a three-week cooldown per content kind within a community.
- **What she has** — a published testimonial, an active package, real
  availability, a photo, at least one student. These are prerequisites, not
  preferences: a testimonial post is never planned for a teacher with no
  testimonial, because the alternative is a model inventing a student quote.
- **Her time** — the plan is sized to the minutes per week she stated, at about
  twelve minutes per action, between two and seven actions.
- **Referral moments** — a student whose lesson completed recently and who has
  not been asked in ninety days.

Ordering is deliberate: the highest-confidence action comes first, so a teacher
who only ever does the top item is still doing the best available thing. A
referral ask leads the week whenever there is a genuine moment for one, because
it is the cheapest action in the plan and converts better than any cold post.

Promotion is rationed at one promotional action per three posts even where a
community permits it. Educational content is the default, because useful content
acquires students in places where an advertisement is unwelcome.

---

## Communities and the promotion policy

A community is a place a teacher can reach learners: a Facebook group, a Reddit
community, a WhatsApp circle, an Instagram audience, somewhere local. It carries
a **promotion policy** — open, limited, prohibited, or unconfirmed — which is
what the community's own rules say, as she recorded them.

This field is the enforcement point of the whole system. A promotional action is
never planned into a community that is not open or limited, and **unconfirmed is
treated as not allowed**: a teacher who has not told us a community's rules gets
educational content there, never an offer. Silence is not consent.

Reddit communities default to prohibited, because Reddit's own culture treats
unsolicited self-promotion as spam and starting anywhere else would ship the ban
as the default experience.

### What "limited" actually means ([D-155](../decisions/D-155.md))

`limited` was the honest answer for most real groups, and on its own it said
nothing further — so the teacher recorded the coarse policy and kept the real
rule in her head. A community that allows promotion now carries the specifics,
split by what the app can honestly enforce:

- **Days** — which weekdays promotion is permitted. **No days selected means
  any day**, never "no days": the unconfigured state must not be the blocking
  one.
- **Frequency** — at most one promotional post every N days, counted from the
  last post she **marked as done** in that community. A draft she never posted
  is not a promotion.
- **Links** — an explicit answer that overrides the platform's own convention
  in both directions. A `no` stops a tracked code being minted at all; a `yes`
  still cannot open a community whose policy is prohibited or unconfirmed.
- **Anything else the rules say** — free text, which rides into the generation
  prompt as quoted rules and is **not enforceable**. The UI says so in as many
  words, because a teacher who believes otherwise will trust it with something
  that matters.

The first three are deterministic and are what the app acts on. The window they
describe is **advisory** — the card tells her today is not a promotion day and
when the next one is; it never stops her posting. She is the one who read the
group's rules, and a mistyped rule must not lock her out of her own community.
It is computed against **her** timezone: a UTC weekday would tell a teacher west
of Greenwich that Monday's window closed on Sunday evening.

### The post, the picture and the link, in one place

Each community card carries its tracked link, a **post** and an **image**.

The post is a `MarketingActivity` — the same entity the weekly plan uses, not a
parallel one — so a post written from a community card carries the same tracked
link, is measured by the same results screen, and is editable in the same place.
There is **one live draft per community**; marking it done retires it, so a post
already in a feed is never overwritten.

The image brief has three authors, and the UI names them in those terms:

1. **SpiralClass** — the rules that never change (no text inside the image, a
   composition that survives a thumbnail, nothing unsafe). Not editable, but
   **shown**: a "What we'll ask for" disclosure restates the whole brief in her
   words. A teacher who cannot see why her request was altered concludes the
   tool ignored her.
2. **The teacher** — her general instructions and preferred visual register,
   written once and used everywhere. The default register rotates, so an
   untouched account gets variety rather than the same picture forever.
3. **The community** — what lands with that particular audience, layered on top
   rather than replacing.

Her caption is still drawn over the image by SpiralClass rather than by the
image model ([D-123](../decisions/D-123.md)): a misspelt Spanish meme posted by
a Spanish teacher discredits the exact expertise she is advertising, and accents
are where image models fail.

Images live in one library she owns, with rename and delete. Deleting one is
refused while a post she has marked done still uses it; otherwise the placements
fall back to the standard card, any draft keeps its text and loses its picture,
and the stored file is removed.

---

## What SpiralClass does and does not automate

It automates everything **around** participating in a community:

- deciding which community deserves this week's attention, and why
- writing the post, in a variant specific to that platform and that community
- generating the image where one helps
- minting the tracked link
- recording what happened afterwards and feeding it back into the next plan

It does **not** post anything, anywhere, on anyone's behalf, and it does not
scrape or discover communities. Facebook removed Groups publishing in 2024 and
Reddit treats unsolicited promotion as spam, so a product that automated the
posting would be handing teachers a ban rather than a marketing department. The
teacher keeps her own account and her own voice; she reviews, edits if she wants
to, and posts.

---

## Attribution: activity to visitor to student

Every prepared action that may carry a link gets a short tracked link,
`/g/<code>`. Opening it stamps the first-touch attribution cookie and redirects
to a clean `/b/<slug>` — the visitor never sees a tracking parameter, and neither
does the community she came from.

Four events are recorded in `acquisition_events`, each carrying the attribution
that produced it:

- **visit** — a booking-page view, deduped per browser per twelve hours
- **enquiry** — a contact-form submission
- **booking** — a checkout started; this is the last point a browser cookie is
  readable
- **purchase** — a settled payment, inheriting the booking row's attribution,
  because a webhook arrives with no browser attached

Referrals are a first-class channel rather than a discount detail: a purchase
made through a student's referral code is attributed to referrals, not to
whatever social source the friend happened to arrive from.

Links posted before this system existed, carrying the older `utm_content`
share-group tag, still resolve to their community. Both schemes coexist.

**Privacy.** The stored visitor identifier is an HMAC of a first-party cookie
under a server-side secret. No IP address, no user agent and no referrer path is
stored — only a referring origin, already capped and charset-limited.

---

## Results, and what the product refuses to claim

The results screen shows the funnel by channel, by community and by content type
over thirty or ninety days, then a short list of findings. Each finding is
labelled:

- **Dato / Observed** — a raw fact, or an honest statement that there is not yet
  enough data.
- **Patrón / Pattern** — a comparison that cleared both a sample-size floor
  (twenty visits on each side) and an effect-size floor (a difference of at least
  one and a half times).
- **Sugerencia / Suggestion** — an action implied by the findings above it.

Nothing here is generated. Every number is a count and every finding is
arithmetic, so a language model never gets to conclude that a channel is working.
Below the floors the screen says there is not enough data yet, rather than
ranking noise.

---

## Where the data lives

- `teacher_marketing_profiles` — the four things that cannot be inferred:
  audiences, learner locations, level focus, differentiator, plus weekly minutes
  and a monthly goal. Everything else the generator uses — subject, prices,
  packages, open days, testimonials, bio, photo, student count — is read off the
  account she already maintains.
- `marketing_plans` — one week per teacher, unique on the Monday it starts.
- `marketing_activities` — one prepared action, its generated body and image, its
  tracked link, and the structured reason it was planned.
- `acquisition_events` — the append-only funnel ledger.
- `teacher_share_groups` — the community, generalised in place from the
  Facebook-group row. Same table, same ids, same links already posted. Also
  carries what `limited` means here (`promo_weekdays`, `promo_every_days`,
  `promo_links_allowed`, `promo_notes`) and the community's own image
  instructions (`meme_brief`).
- `social_preview_images` — the image library, generated or uploaded, shared
  with the social-preview pipeline ([D-123](../decisions/D-123.md)). The
  teacher's general image instructions and her visual register live beside her
  acquisition profile, on `teacher_marketing_profiles`.
