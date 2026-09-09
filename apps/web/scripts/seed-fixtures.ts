// Fixtures for every surface `seed.ts` leaves empty.
//
// WHY THIS FILE EXISTS. `seed.ts` builds the spine — teachers, students,
// packages, bookings, payments, subscriptions — and stops. That is enough to
// sign in and enough for the E2E suite, and it means a fresh clone opens
// homework, lesson insights, messages, notifications, materials, levels, focus
// tags, referrals, leads, acquisition and the admin console on an empty state.
// Seventeen of eighty-two models had fixtures; sixty-five did not.
//
// A reader who runs `pnpm setup && pnpm dev` should see the product, not its
// empty states. So should a screenshot.
//
// THREE RULES, and they are the whole design.
//
//   1. NOTHING LEAVES THE PROCESS. No Stripe call, no R2 upload, no model
//      inference. Storage paths are plausible strings pointing at nothing and
//      every surface that reads one degrades exactly as it does when a vendor
//      key is missing — which is the state the README promises a fresh clone.
//      That also makes this run identically on a laptop with no credentials
//      and on preview with all of them.
//
//   2. NO FIXTURE IS A USABLE CREDENTIAL. `Session`, `Account`, `Verification`
//      and `TwoFactor` are better-auth's own tables, and a seeded row there is
//      not decoration — a live session token is a login. Every one written here
//      is inert by construction: sessions already expired, verifications
//      already consumed, tokens that are visibly fake strings rather than
//      plausible ones. They exist so the admin surfaces that count them are not
//      empty, and for no other reason.
//
//   3. DETERMINISTIC. One seeded PRNG, no `Math.random`, no `Date.now()`
//      outside the `now` passed in. Two runs of the seed produce the same
//      database, so a visual baseline taken against it means something.
//
// ⚠️ It queries the seeded rows back rather than taking them as arguments.
// `seedHero` returns nothing today, and threading a return value through it
// would couple this file to the order in which that one happens to build
// things. Reading `seeded_at` — the ownership marker the schema already
// defines — is both looser and more honest: whatever the spine created, this
// decorates.
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import { ensureIntegrationsSeeded } from "@/lib/economics/seed-registry";
import { ensureTeacherFocusTags } from "@/lib/focus-tags";
import { recomputeStudentProfile } from "@/lib/lesson-notes/profile";
import { ensureTeacherLevels } from "@/lib/levels";

/** Deterministic PRNG — the same one `seed.ts` uses, seeded independently. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0x5c1a55);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const chance = (p: number): boolean => rng() < p;
const days = (from: Date, n: number) => new Date(from.getTime() + n * 86_400_000);
const mins = (from: Date, n: number) => new Date(from.getTime() + n * 60_000);

/**
 * The marker every fixture row carries in a free-text column, so the reset
 * below can find exactly what this file wrote and nothing else.
 */
const FIXTURE_MARKER = "seed-fixture";

/**
 * Deletes what `seed.ts`'s own cleanup cannot reach.
 *
 * That cleanup hard-deletes the seed teachers and students, and everything
 * FK'd to them cascades away. **Nine of the models here have no such FK.**
 * `notifications`, `web_push_subscriptions`, `webhook_events`,
 * `platform_expenses`, `usage_inputs`, `alpha_allowlist_entries`,
 * `account_deletion_requests`, `uat_checklist_state` and `verification` all
 * carry a plain id or no owner at all — and better-auth's `session`, `account`
 * and `two_factor` FK to `user`, which the seed deliberately REUSES by email
 * rather than deleting, so those survive too.
 *
 * The symptom is that the seed works once. The second run died on
 * `web_push_subscriptions.endpoint`, which is globally unique, and the rest
 * would have quietly doubled every row instead — which is worse, because
 * nothing would have failed.
 *
 * ⚠️ It deletes BY MARKER, never by table. On preview these tables hold real
 * rows: a genuine push subscription, a real Stripe webhook, an actual deletion
 * request. Truncating any of them to make a fixture idempotent would destroy
 * production-shaped data to save a re-run.
 */
async function resetFixtures(ctx: Ctx, seededTeacherIds: string[]): Promise<void> {
  const { prisma } = ctx;

  await prisma.webPushSubscription.deleteMany({
    where: { endpoint: { startsWith: "https://push.example.test/seed/" } },
  });
  await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_seed_" } } });
  await prisma.dispute.deleteMany({ where: { stripeDisputeId: { startsWith: "dp_seed_" } } });
  await prisma.accountDeletionRequest.deleteMany({
    where: { email: { endsWith: "@example.test" } },
  });
  await prisma.alphaAllowlistEntry.deleteMany({ where: { addedBy: FIXTURE_MARKER } });
  await prisma.platformExpense.deleteMany({ where: { notes: FIXTURE_MARKER } });
  await prisma.usageInput.deleteMany({ where: { source: FIXTURE_MARKER } });
  await prisma.verification.deleteMany({ where: { value: { startsWith: FIXTURE_MARKER } } });
  await prisma.session.deleteMany({ where: { token: { startsWith: "seed-expired-session-" } } });
  await prisma.account.deleteMany({ where: { accountId: { startsWith: "seed-google-" } } });
  await prisma.twoFactor.deleteMany({ where: { secret: { startsWith: "SEEDFIXTURE" } } });

  // Notifications carry a teacherId but no foreign key, so scope by the
  // teachers this run is about to decorate rather than by a marker.
  if (seededTeacherIds.length > 0) {
    await prisma.notification.deleteMany({ where: { teacherId: { in: seededTeacherIds } } });
  }
}

/** Rows written, by model. Returned so the seed can print it and a test can assert it. */
export type FixtureCounts = Record<string, number>;

type Ctx = {
  prisma: PrismaClient;
  now: Date;
  counts: FixtureCounts;
};

/** Records what was written, so "seeded everything" is a number rather than a claim. */
async function tally<T>(ctx: Ctx, model: string, work: () => Promise<T>): Promise<T> {
  const before = ctx.counts[model] ?? 0;
  const result = await work();
  const added = Array.isArray(result) ? result.length : typeof result === "number" ? result : 1;
  ctx.counts[model] = before + added;
  return result;
}

// ---------------------------------------------------------------------------
// Per-teacher taxonomy: levels, focus tags, content templates.
// ---------------------------------------------------------------------------

/**
 * Levels and focus tags are created by the PRODUCT'S OWN helpers, not by a list
 * written here.
 *
 * `ensureTeacherLevels` and `ensureTeacherFocusTags` are what a teacher's real
 * onboarding runs, and `focus-packs.ts` behind them carries curated per-subject
 * tag packs. A fixture that reproduced either would drift the moment somebody
 * curated a pack — and the drift would be invisible, because both sides would
 * go on looking plausible.
 *
 * `ensureTeacherLevels` is already called by `seed.ts` for every teacher, so
 * this only reads the rows back. That call is also why the first version of
 * this file failed with a unique-constraint violation on `levels`: the gap
 * analysis behind it looked for `prisma.level.create` and never saw a helper.
 */
async function seedTaxonomy(
  ctx: Ctx,
  teacher: { id: string; targetLanguage: string | null; locale: string },
) {
  const { prisma } = ctx;

  await ensureTeacherLevels(teacher.id, prisma);
  await ensureTeacherFocusTags(
    teacher.id,
    teacher.targetLanguage,
    teacher.locale === "es-MX" ? "es-MX" : "en",
    prisma,
  );

  const levels = await prisma.level.findMany({
    where: { teacherId: teacher.id },
    select: { id: true },
    orderBy: { position: "asc" },
  });
  const focusTags = await prisma.focusTag.findMany({
    where: { teacherId: teacher.id },
    select: { id: true },
    orderBy: { position: "asc" },
  });

  await tally(ctx, "ClassContentTemplate", async () =>
    Promise.all(
      [
        { label: "Warm-up questions", body: "Three questions to open the class with." },
        { label: "Grammar drill", body: "A short drill on the target structure." },
        { label: "Homework brief", body: "What to practise before the next class." },
      ].map((t, i) =>
        prisma.classContentTemplate.create({
          data: { teacherId: teacher.id, label: t.label, body: t.body, position: i },
        }),
      ),
    ),
  );

  return { levels, focusTags };
}

// ---------------------------------------------------------------------------
// Library materials, and everything that hangs off one.
// ---------------------------------------------------------------------------

const MATERIAL_SEEDS = [
  {
    label: "Ser vs. estar — the ten cases that matter",
    unit: "Unit 1 · Core contrasts",
    body: "# Ser vs. estar\n\nTen sentence pairs where the choice changes the meaning, not just the register.\n\n1. **Es aburrido** / **Está aburrido**\n2. **Es listo** / **Está listo**\n",
  },
  {
    label: "Past tenses — indefinido or imperfecto?",
    unit: "Unit 2 · Talking about the past",
    body: "# Indefinido vs. imperfecto\n\nA finished action against a described state. Read the paragraph, then justify each choice out loud.\n",
  },
  {
    label: "Ordering in a restaurant — role play",
    unit: "Unit 3 · Everyday situations",
    body: "# En el restaurante\n\nTwo roles, one menu, and a waiter who has run out of the first thing you ask for.\n",
  },
  {
    label: "Subjunctive after expressions of doubt",
    unit: "Unit 4 · Subjunctive",
    body: "# Dudo que…\n\nWhen doubt takes the subjunctive, and the handful of expressions that look like doubt and do not.\n",
  },
  {
    label: "Listening — a two-minute news bulletin",
    unit: "Unit 5 · Listening",
    body: "# Boletín\n\nPlayed twice. First for gist, then for the four numbers.\n",
  },
];

async function seedMaterials(
  ctx: Ctx,
  teacher: { id: string },
  levels: { id: string }[],
  focusTags: { id: string }[],
) {
  const { prisma, now } = ctx;

  const materials = await tally(ctx, "LibraryMaterial", async () =>
    Promise.all(
      MATERIAL_SEEDS.map((m, i) =>
        prisma.libraryMaterial.create({
          data: {
            teacherId: teacher.id,
            levelId: levels[Math.min(i, levels.length - 1)]!.id,
            unit: m.unit,
            position: i,
            label: m.label,
            body: m.body,
            contentSource: i % 2 === 0 ? "manual" : "ai",
            visibility: "at_or_below",
            createdAt: days(now, -30 + i),
          },
        }),
      ),
    ),
  );

  // A revision history on the first two, so the material editor has something
  // to show. `ai` provenance on the later revision is the realistic shape: a
  // teacher edits by hand, then regenerates.
  await tally(ctx, "MaterialRevision", async () =>
    Promise.all(
      materials.slice(0, 2).flatMap((m, i) =>
        [0, 1].map((r) =>
          prisma.materialRevision.create({
            data: {
              materialId: m.id,
              teacherId: teacher.id,
              body: `${MATERIAL_SEEDS[i]!.body}\n\n<!-- revision ${r + 1} -->`,
              source: r === 0 ? "manual" : "ai",
              createdAt: days(now, -20 + r),
            },
          }),
        ),
      ),
    ),
  );

  // One ready podcast and one that failed — the failure state is a real one and
  // nothing else in the fixtures exercises it.
  await tally(ctx, "MaterialPodcast", async () => [
    await prisma.materialPodcast.create({
      data: {
        materialId: materials[0]!.id,
        teacherId: teacher.id,
        status: "ready",
        storagePath: `teachers/${teacher.id}/podcasts/ser-estar.mp3`,
        script: "Host A: Vamos a hablar de ser y estar…",
        durationSec: 412,
        voice: "es-MX-standard",
        generatedAt: days(now, -18),
      },
    }),
    await prisma.materialPodcast.create({
      data: {
        materialId: materials[1]!.id,
        teacherId: teacher.id,
        status: "failed",
        error: "TTS provider returned 429 (rate limited)",
      },
    }),
  ]);

  await tally(ctx, "LibraryMaterialFocusTag", async () =>
    Promise.all(
      materials.flatMap((m, i) =>
        focusTags.slice(i * 2, i * 2 + 2).map((t) =>
          prisma.libraryMaterialFocusTag.create({
            data: { libraryMaterialId: m.id, focusTagId: t.id },
          }),
        ),
      ),
    ),
  );

  return materials;
}

// ---------------------------------------------------------------------------
// Everything that hangs off a completed class.
// ---------------------------------------------------------------------------

const INSIGHTS = [
  {
    category: "grammar" as const,
    skill: "ser_vs_estar",
    summary: "Uses ser for temporary emotional states",
    evidence: "«soy cansado» — for «estoy cansado»",
    suggestion: "Estar for conditions that change; ser for what something is.",
  },
  {
    category: "pronunciation" as const,
    skill: "rr_trill",
    summary: "The rolled rr collapses to a single tap under speed",
    evidence: "«pero» and «perro» sounded identical at conversational pace",
    suggestion: "Minimal pairs at half speed, then build back up.",
  },
  {
    category: "vocabulary" as const,
    skill: "false_friends",
    summary: "Reaches for the English cognate when the register is formal",
    evidence: "«actualmente» used to mean «actually»",
    suggestion: "Actualmente = currently. En realidad = actually.",
  },
  {
    category: "fluency" as const,
    skill: "hesitation",
    summary: "Self-corrects mid-clause rather than finishing and repairing after",
    evidence: "Four restarts in one 40-second answer",
    suggestion: "Finish the sentence wrong, then fix it. Fluency first.",
  },
  {
    category: "comprehension" as const,
    skill: "fast_speech",
    summary: "Loses the subject when the verb is dropped",
    evidence: "Missed who was arriving in «llegan el jueves»",
    suggestion: "Listening for verb endings as the subject marker.",
  },
];

async function seedClassArtefacts(
  ctx: Ctx,
  teacher: { id: string; targetLanguage: string | null },
  booking: { id: string; studentId: string; scheduledStart: Date },
  materials: { id: string }[],
  index: number,
) {
  const { prisma, now } = ctx;
  const lang = teacher.targetLanguage ?? "es";

  // --- The recording plane: a composite recording plus per-speaker audio.
  await tally(ctx, "CallRecording", () =>
    prisma.callRecording.create({
      data: {
        bookingId: booking.id,
        teacherId: teacher.id,
        egressId: `EG_${booking.id.slice(0, 12)}`,
        storageKey: `recordings/${booking.id}/composite.mp4`,
        status: "complete",
        startedAt: booking.scheduledStart,
        endedAt: mins(booking.scheduledStart, 50),
      },
    }),
  );

  await tally(ctx, "LessonAudio", async () =>
    Promise.all(
      (["teacher", "student"] as const).map((speaker) =>
        prisma.lessonAudio.create({
          data: {
            bookingId: booking.id,
            teacherId: teacher.id,
            speaker,
            egressId: `EG_${speaker}_${booking.id.slice(0, 8)}`,
            storageKey: `lesson-audio/${booking.id}/${speaker}.ogg`,
            status: "complete",
            durationMs: 50 * 60_000,
            startedAt: booking.scheduledStart,
            endedAt: mins(booking.scheduledStart, 50),
          },
        }),
      ),
    ),
  );

  // A transcript that fills a plausible share of a 50-minute class.
  //
  // ⚠️ FOUR UTTERANCES IS NOT A TRANSCRIPT. The first version of this fixture
  // had exactly that, and the class page's speaking-time card read
  // "teacher 0% · student 0% · silence 100%" — correctly, because 26 seconds of
  // speech across fifty minutes rounds to nothing. `computeSpeakingTime` divides
  // by the LessonAudio duration, so a fixture transcript has to be dense enough
  // to produce a share a person would recognise. This one lands near 45/25/30.
  const TURNS: { speaker: "teacher" | "student"; text: string; sec: number }[] = [
    { speaker: "teacher", text: "¿Cómo te fue la semana?", sec: 6 },
    { speaker: "student", text: "Soy cansado, trabajé mucho.", sec: 8 },
    { speaker: "teacher", text: "Estoy cansado. Es un estado, no una característica.", sec: 11 },
    { speaker: "student", text: "Ah, estoy cansado. Gracias.", sec: 5 },
    { speaker: "teacher", text: "Cuéntame qué hiciste el fin de semana.", sec: 7 },
    { speaker: "student", text: "Fui al mercado y compré fruta. Estaba lloviendo.", sec: 13 },
    {
      speaker: "teacher",
      text: "Muy bien — «estaba lloviendo» es el imperfecto, la descripción.",
      sec: 14,
    },
    { speaker: "student", text: "Sí, y después estuve en casa toda la tarde.", sec: 9 },
    { speaker: "teacher", text: "Perfecto. Ahora vamos a practicar pero y perro.", sec: 8 },
    { speaker: "student", text: "Pero… perro. Es difícil.", sec: 6 },
    { speaker: "teacher", text: "Más despacio. La lengua toca el paladar varias veces.", sec: 12 },
    { speaker: "student", text: "Perro. Perro. Mejor, ¿no?", sec: 7 },
    {
      speaker: "teacher",
      text: "Mucho mejor. Una cosa más: «actualmente» no es «actually».",
      sec: 13,
    },
    { speaker: "student", text: "¿Entonces cómo digo actually?", sec: 5 },
    { speaker: "teacher", text: "«En realidad». Actualmente significa currently.", sec: 9 },
    { speaker: "student", text: "En realidad, no sabía eso.", sec: 6 },
  ];

  await tally(ctx, "LessonTranscript", () => {
    // Fill the lesson rather than emitting a fixed number of turns. The card
    // divides speech by the LessonAudio duration, so "how many utterances" is
    // the wrong knob — "how much of the fifty minutes is speech" is the one a
    // reader sees. Stops at ~72%, which leaves a believable silence share
    // instead of a wall of talking.
    const lessonMs = 50 * 60_000;
    const target = lessonMs * 0.72;
    const utterances: {
      speaker: string;
      startMs: number;
      endMs: number;
      text: string;
      words: never[];
    }[] = [];
    let atMs = 9_000;
    let spoken = 0;
    let i = 0;
    while (spoken < target && atMs < lessonMs - 5_000) {
      const turn = TURNS[i % TURNS.length]!;
      i += 1;
      const durMs = turn.sec * 1000;
      if (atMs + durMs > lessonMs) break;
      utterances.push({
        speaker: turn.speaker,
        startMs: atMs,
        endMs: atMs + durMs,
        text: turn.text,
        words: [],
      });
      spoken += durMs;
      atMs += durMs + 400 + Math.floor(rng() * 1400);
    }

    return prisma.lessonTranscript.create({
      data: {
        bookingId: booking.id,
        teacherId: teacher.id,
        language: lang,
        provider: "deepgram",
        utterances: utterances satisfies Prisma.InputJsonValue,
      },
    });
  });

  await tally(ctx, "LessonPronunciation", () =>
    prisma.lessonPronunciation.create({
      data: {
        bookingId: booking.id,
        teacherId: teacher.id,
        language: lang,
        provider: "azure-speech",
        scores: {
          overall: 72 + Math.floor(rng() * 18),
          fluency: 68 + Math.floor(rng() * 20),
          accuracy: 74 + Math.floor(rng() * 16),
          words: [
            { word: "perro", score: 54 },
            { word: "carro", score: 61 },
            { word: "gracias", score: 93 },
          ],
        } satisfies Prisma.InputJsonValue,
      },
    }),
  );

  // --- The derived layer: summary, insights, brief.
  await tally(ctx, "LessonSummary", () =>
    prisma.lessonSummary.create({
      data: {
        bookingId: booking.id,
        teacherId: teacher.id,
        model: "claude-sonnet-4-5",
        body: [
          "Conversation practice built around the past week, with a detour into ser/estar when it came up naturally.",
          "",
          "**What went well.** Held a five-minute stretch with no English. Past-tense endings were reliable in the regular verbs.",
          "",
          "**What to work on.** Ser is standing in for estar with emotional and physical states. The rolled rr is intermittent under speed.",
        ].join("\n"),
        createdAt: mins(booking.scheduledStart, 62),
      },
    }),
  );

  // Two or three findings per class, confirmed on the older ones — the state a
  // teacher's longitudinal profile is actually built from.
  const chosen = [INSIGHTS[index % INSIGHTS.length]!, INSIGHTS[(index + 2) % INSIGHTS.length]!];
  await tally(ctx, "LessonInsight", async () =>
    Promise.all(
      chosen.map((ins, i) =>
        prisma.lessonInsight.create({
          data: {
            bookingId: booking.id,
            teacherId: teacher.id,
            category: ins.category,
            summary: ins.summary,
            skill: ins.skill,
            evidence: ins.evidence,
            suggestion: ins.suggestion,
            atMs: 120_000 + i * 380_000,
            source: i === 0 ? "ai" : "teacher",
            confirmedAt: index > 0 ? mins(booking.scheduledStart, 70) : null,
          },
        }),
      ),
    ),
  );

  await tally(ctx, "LessonBrief", () =>
    prisma.lessonBrief.create({
      data: {
        bookingId: booking.id,
        teacherId: teacher.id,
        model: "claude-sonnet-4-5",
        content: {
          focus: chosen.map((c) => c.skill),
          warmUp: "Two minutes on the weekend, in the past tense.",
          activities: [
            "Minimal pairs: pero / perro, caro / carro.",
            "Ten ser/estar sentence pairs, said aloud with a reason.",
          ],
          homework: "Record ninety seconds describing a photograph.",
        } satisfies Prisma.InputJsonValue,
        generatedAt: mins(booking.scheduledStart, 65),
      },
    }),
  );

  // --- Notes the teacher took during the class, plus one for the student.
  await tally(ctx, "LessonNote", async () =>
    Promise.all(
      [
        {
          audience: "teacher" as const,
          kind: "text" as const,
          body: "Ser/estar again — worth a whole class.",
        },
        {
          audience: "teacher" as const,
          kind: "bookmark" as const,
          body: "Good self-correction at 12:40",
        },
        {
          audience: "student" as const,
          kind: "text" as const,
          body: "Practise: estoy cansado, no soy cansado.",
        },
      ].map((n, i) =>
        prisma.lessonNote.create({
          data: {
            bookingId: booking.id,
            teacherId: teacher.id,
            audience: n.audience,
            kind: n.kind,
            body: n.body,
            position: i,
            doneAt: n.audience === "student" && index > 1 ? mins(booking.scheduledStart, 90) : null,
          },
        }),
      ),
    ),
  );

  // --- Materials attached to the class, and the record of one being opened.
  const attached = materials.slice(index % 3, (index % 3) + 2);
  await tally(ctx, "BookingLibraryMaterial", async () =>
    Promise.all(
      attached.map((m, i) =>
        prisma.bookingLibraryMaterial.create({
          data: {
            bookingId: booking.id,
            libraryMaterialId: m.id,
            sendTiming: (["confirmation", "t_24h", "t_1h"] as const)[i % 3]!,
          },
        }),
      ),
    ),
  );

  await tally(ctx, "ClassMaterialUse", () =>
    prisma.classMaterialUse.create({
      data: {
        teacherId: teacher.id,
        bookingId: booking.id,
        materialId: attached[0]?.id ?? materials[0]!.id,
        openedAt: mins(booking.scheduledStart, 8),
        openedFor: "teacher",
      },
    }),
  );

  // --- Homework, end to end: assignment → submission → attempt → feedback.
  const assignment = await tally(ctx, "Assignment", () =>
    prisma.assignment.create({
      data: {
        bookingId: booking.id,
        teacherId: teacher.id,
        title: "Ninety seconds describing a photograph",
        instructions:
          "Pick any photo on your phone. Record yourself describing it for ninety seconds, in the past tense where it fits.",
        dueAt: days(booking.scheduledStart, 6),
        allowLateSubmission: true,
        allowResubmission: index % 2 === 0,
        sourceMaterialId: materials[0]!.id,
      },
    }),
  );

  const submission = await tally(ctx, "HomeworkSubmission", () =>
    prisma.homeworkSubmission.create({
      data: {
        assignmentId: assignment.id,
        studentId: booking.studentId,
        teacherId: teacher.id,
        textResponse: "Aquí está mi descripción. Creo que usé bien el imperfecto.",
        status: index === 0 ? "submitted" : "graded",
        submittedAt: days(booking.scheduledStart, 3),
      },
    }),
  );

  const attempt = await tally(ctx, "HomeworkAttempt", () =>
    prisma.homeworkAttempt.create({
      data: {
        submissionId: submission.id,
        attemptNumber: 1,
        textResponse: "Aquí está mi descripción. Creo que usé bien el imperfecto.",
        submittedAt: days(booking.scheduledStart, 3),
      },
    }),
  );

  await tally(ctx, "HomeworkSubmissionFile", () =>
    prisma.homeworkSubmissionFile.create({
      data: {
        submissionId: submission.id,
        teacherId: teacher.id,
        attemptId: attempt.id,
        storagePath: `homework/${submission.id}/descripcion.m4a`,
        fileName: "descripcion.m4a",
        fileType: "audio/mp4",
        fileSize: 1_284_400,
        uploadedAt: days(booking.scheduledStart, 3),
      },
    }),
  );

  const draft = await tally(ctx, "HomeworkAiReviewDraft", () =>
    prisma.homeworkAiReviewDraft.create({
      data: {
        attemptId: attempt.id,
        teacherId: teacher.id,
        model: "claude-sonnet-4-5",
        instructions: "Mark for past-tense accuracy. Encourage first.",
        content: {
          strengths: ["Imperfecto used correctly for background description."],
          corrections: [
            {
              was: "estuve caminando",
              shouldBe: "estaba caminando",
              why: "Ongoing background action.",
            },
          ],
        } satisfies Prisma.InputJsonValue,
        // The older ones were discarded rather than sent — a real teacher does
        // not accept every draft, and the surface has to show that state.
        discardedAt: index > 1 ? days(booking.scheduledStart, 4) : null,
      },
    }),
  );

  if (index !== 0) {
    await tally(ctx, "HomeworkFeedback", () =>
      prisma.homeworkFeedback.create({
        data: {
          attemptId: attempt.id,
          teacherId: teacher.id,
          decision: index % 3 === 0 ? "resubmission_requested" : "approved",
          content:
            "Good — the imperfecto is doing the right work here. One fix: «estaba caminando», not «estuve caminando».",
          score: 4,
          aiDraftId: draft.discardedAt ? null : draft.id,
          createdAt: days(booking.scheduledStart, 4),
        },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Per-student, across classes.
// ---------------------------------------------------------------------------

const VOCAB = [
  "el imperfecto",
  "la sobremesa",
  "madrugar",
  "el atasco",
  "echar de menos",
  "quedarse en blanco",
  "dar igual",
  "tener ganas de",
  "estar harto",
  "de repente",
];

async function seedStudentArtefacts(
  ctx: Ctx,
  teacher: { id: string },
  student: { id: string; name: string | null },
  materials: { id: string }[],
  levels: { id: string }[],
  index: number,
) {
  const { prisma, now } = ctx;

  // The teacher–student relationship itself. `seed.ts` creates the join row
  // with nothing on it, so the class page's "What to teach" card read
  // "Level: Not set · Learning goal: Not set yet · Interests: Not set yet" —
  // three empty states on the surface a teacher opens most.
  //
  // `insightsConsentAt` matters beyond looking populated: lesson insights are
  // gated on an explicit per-student consent (D-22), so without it the focus
  // areas seeded against this student's classes are correctly invisible.
  await prisma.teacherStudent.update({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId: student.id } },
    data: {
      levelId: levels[Math.min(index + 1, levels.length - 1)]?.id ?? null,
      goals: [
        "Hold a ten-minute conversation without switching to English.",
        "Pass the B1 oral exam in the spring.",
        "Understand her partner's family at Sunday lunch.",
      ][index % 3]!,
      interests: [
        "Cooking, football, true crime podcasts",
        "Travel, architecture, jazz",
        "Cycling, history, cinema",
      ][index % 3]!,
      insightsConsentAt: days(now, -45),
      captionsConsentAt: days(now, -45),
    },
  });

  // The longitudinal profile is BUILT by the product, not written here.
  //
  // `profileSchema` expects `{ byCategory, vocabulary, speakingBalance }`, and
  // the first version of this fixture invented `{ level, strengths, working_on }`
  // instead — which parses as invalid, so the Learning tab rendered "No profile
  // yet. Confirm focus areas after a class to start building it." on a student
  // who had six confirmed findings. A fixture that fabricates a shape the
  // reader validates is worse than no fixture: it looks like a product bug.
  //
  // `recomputeStudentProfile` is what the app runs after a teacher confirms an
  // insight. It reads the rows seeded above, so the profile is derived from the
  // same data the class pages show rather than asserted alongside it.
  await tally(ctx, "StudentLearningProfile", async () => {
    await recomputeStudentProfile(prisma, { teacherId: teacher.id, studentId: student.id });
    return 1;
  });

  await tally(ctx, "VocabularyReview", async () =>
    Promise.all(
      VOCAB.slice(0, 6).map((term, i) =>
        prisma.vocabularyReview.create({
          data: {
            teacherId: teacher.id,
            studentId: student.id,
            term,
            intervalDays: [0, 1, 3, 7, 14, 30][i] ?? 1,
            easeFactor: 2.3 + rng() * 0.4,
            dueAt: days(now, i - 2),
            lastReviewedAt: i > 0 ? days(now, -(i * 2)) : null,
          },
        }),
      ),
    ),
  );

  await tally(ctx, "StudentNote", async () =>
    Promise.all(
      [
        "Prefers being corrected at the end, not mid-sentence.",
        "Travelling in August — pause the package rather than expire it.",
      ].map((body, i) =>
        prisma.studentNote.create({
          data: {
            teacherId: teacher.id,
            studentId: student.id,
            body,
            createdAt: days(now, -20 + i * 7),
          },
        }),
      ),
    ),
  );

  await tally(ctx, "StudentLibraryItem", async () =>
    Promise.all(
      materials.slice(0, 3).map((m, i) =>
        prisma.studentLibraryItem.create({
          data: {
            teacherId: teacher.id,
            studentId: student.id,
            libraryMaterialId: m.id,
            assignedAt: days(now, -14 + i * 3),
            completedAt: i === 0 ? days(now, -10) : null,
            completedBy: i === 0 ? "student" : null,
          },
        }),
      ),
    ),
  );

  // A short conversation, most of it read, the last message not — so the inbox
  // has an unread badge and the thread has a natural end.
  const thread = [
    {
      role: "student",
      body: "Hola! Quick question about the homework — should it be in the past?",
    },
    { role: "teacher", body: "Yes — past tense where it fits. Imperfecto for the description." },
    { role: "student", body: "Perfect, thank you. Sending it tonight." },
    { role: "teacher", body: "No rush. See you Thursday." },
  ] as const;

  let previous: { id: string } | null = null;
  const messages: { id: string }[] = [];
  for (const [i, m] of thread.entries()) {
    const row = await tally(ctx, "Message", () =>
      prisma.message.create({
        data: {
          teacherId: teacher.id,
          studentId: student.id,
          senderRole: m.role,
          body: m.body,
          createdAt: mins(days(now, -2), i * 17),
          readAt: i < thread.length - 1 ? mins(days(now, -2), i * 17 + 4) : null,
          replyToId: i === 1 && previous ? previous.id : null,
        },
      }),
    );
    previous = row;
    messages.push(row);
  }

  await tally(ctx, "MessageReaction", () =>
    prisma.messageReaction.create({
      data: { messageId: messages[1]!.id, reactorRole: "student", emoji: "👍" },
    }),
  );

  await tally(ctx, "StudentContactChange", () =>
    prisma.studentContactChange.create({
      data: {
        studentId: student.id,
        actorType: "student",
        beforeJson: {
          email: `old.${student.id.slice(0, 6)}@example.test`,
        } satisfies Prisma.InputJsonValue,
        afterJson: {
          email: `new.${student.id.slice(0, 6)}@example.test`,
        } satisfies Prisma.InputJsonValue,
        createdAt: days(now, -35),
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Per-teacher: growth, calendar, payouts, marketing.
// ---------------------------------------------------------------------------

const COMMUNITIES = [
  { name: "Expats in Mexico City", platform: "facebook_group", promoPolicy: "prohibited" },
  { name: "r/Spanish", platform: "reddit", promoPolicy: "restricted" },
  { name: "Language exchange — CDMX", platform: "facebook_group", promoPolicy: "allowed" },
  { name: "Polyglot Discord", platform: "discord", promoPolicy: "unknown" },
];

async function seedTeacherOperations(
  ctx: Ctx,
  teacher: { id: string; pricingCurrency: string },
  students: { id: string; name: string | null }[],
  templates: { id: string; priceMinorUnits: number }[],
  packages: { id: string; studentId: string }[],
  payments: { id: string; packageId: string }[],
) {
  const { prisma, now } = ctx;
  const currency = teacher.pricingCurrency;

  // --- Any package nobody paid for.
  //
  // `seedStudentWithUsage` writes a Payment for every hero teacher's students,
  // but the E2E teacher's roster is built by a different path in `seed.ts` that
  // does not — so every one of HER students showed "Paid to date $0.00 MXN"
  // beside an active package, on the surface the screenshots and the E2E suite
  // both use. Card rail, because a `manual_transfer` payment without an
  // instrument is rejected by `payments_instrument_required_for_manual_transfer`
  // (D-113) and inventing an instrument here would put a payee value in the
  // database that nothing checked.
  const unpaid = await prisma.package.findMany({
    where: { teacherId: teacher.id, payments: { none: {} } },
    select: { id: true, pricePaidMinorUnits: true, purchasedAt: true },
  });
  if (unpaid.length > 0) {
    await tally(ctx, "Payment", async () =>
      Promise.all(
        unpaid.map((pkg) =>
          prisma.payment.create({
            data: {
              packageId: pkg.id,
              amountMinorUnits: pkg.pricePaidMinorUnits,
              currency,
              status: "paid",
              provider: "stripe",
              rail: "card",
              paidAt: pkg.purchasedAt ?? days(now, -20),
            },
          }),
        ),
      ),
    );
  }

  // --- Calendar: a holiday, and a Google connection with imported busy time.
  await tally(ctx, "BlockedDate", async () =>
    Promise.all(
      [
        { start: days(now, 21), end: days(now, 28), reason: "Holiday" },
        { start: days(now, -14), end: days(now, -13), reason: "Doctor" },
      ].map((b) =>
        prisma.blockedDate.create({
          data: { teacherId: teacher.id, startsAt: b.start, endsAt: b.end, reason: b.reason },
        }),
      ),
    ),
  );

  await tally(ctx, "GoogleCalendarConnection", () =>
    prisma.googleCalendarConnection.create({
      data: {
        teacherId: teacher.id,
        googleEmail: `calendar.${teacher.id.slice(0, 6)}@example.test`,
        // Visibly not a token. The column is named `…Enc` and the real value is
        // ciphertext; a fixture that LOOKED like one would be the only thing in
        // this file a scanner could mistake for a credential.
        refreshTokenEnc: "seed-fixture-not-a-real-token",
        syncEnabled: true,
        lastSyncedAt: mins(now, -47),
      },
    }),
  );

  await tally(ctx, "GoogleBusyInterval", async () =>
    Promise.all(
      [1, 3, 6].map((d) =>
        prisma.googleBusyInterval.create({
          data: {
            teacherId: teacher.id,
            startsAt: mins(days(now, d), 9 * 60),
            endsAt: mins(days(now, d), 10 * 60),
          },
        }),
      ),
    ),
  );

  // --- Enquiries and invitations.
  await tally(ctx, "Lead", async () =>
    Promise.all(
      [
        {
          name: "Tom Whitfield",
          status: "new" as const,
          message: "Do you teach business Spanish?",
        },
        {
          name: "Beatriz Soto",
          status: "contacted" as const,
          message: "Looking for two classes a week.",
        },
        { name: "Kenji Aoki", status: "converted" as const, message: null },
        { name: "Camila Peña", status: "archived" as const, message: "Never replied." },
      ].map((l, i) =>
        prisma.lead.create({
          data: {
            teacherId: teacher.id,
            name: l.name,
            email: `${l.name.split(" ")[0]!.toLowerCase()}.${teacher.id.slice(0, 4)}@example.test`,
            phoneE164: i % 2 === 0 ? "+525512345678" : null,
            message: l.message,
            status: l.status,
            createdAt: days(now, -(i + 1) * 5),
          },
        }),
      ),
    ),
  );

  if (students[0]) {
    await tally(ctx, "StudentInvitation", () =>
      prisma.studentInvitation.create({
        data: {
          teacherId: teacher.id,
          studentId: students[0]!.id,
          email: `invited.${teacher.id.slice(0, 6)}@example.test`,
          name: "Invited Student",
          // A hash, not a token: the column stores a digest and the real token
          // never touches the database.
          tokenHash: `seed-fixture-digest-${teacher.id.slice(0, 8)}`,
          status: "pending",
          expiresAt: days(now, 7),
          sentAt: days(now, -1),
          lastSentAt: days(now, -1),
        },
      }),
    );
  }

  // --- Grandfathered pricing: one student keeps last year's price.
  if (students[0] && templates[0]) {
    await tally(ctx, "TeacherStudentTemplatePrice", () =>
      prisma.teacherStudentTemplatePrice.create({
        data: {
          teacherId: teacher.id,
          studentId: students[0]!.id,
          templateId: templates[0]!.id,
          priceMinorUnits: Math.round(templates[0]!.priceMinorUnits * 0.85),
          currency,
        },
      }),
    );
  }

  // --- Discounts and referrals, including one redeemed against a real payment.
  const promo = await tally(ctx, "DiscountCode", async () => [
    await prisma.discountCode.create({
      data: {
        teacherId: teacher.id,
        code: `WELCOME-${teacher.id.slice(0, 4).toUpperCase()}`,
        kind: "percent",
        percentBps: 1000,
        currency,
        origin: "promo",
        maxRedemptions: 25,
        expiresAt: days(now, 60),
      },
    }),
    await prisma.discountCode.create({
      data: {
        teacherId: teacher.id,
        code: `BACK-${teacher.id.slice(0, 4).toUpperCase()}`,
        kind: "fixed",
        amountMinorUnits: 20_000,
        currency,
        origin: "promo",
        active: false,
      },
    }),
  ]);

  await tally(ctx, "ReferralProgram", () =>
    prisma.referralProgram.create({
      data: {
        teacherId: teacher.id,
        enabled: true,
        referredKind: "fixed",
        referredAmountMinorUnits: 15_000,
        referrerKind: "fixed",
        referrerAmountMinorUnits: 15_000,
        currency,
        rewardExpiryDays: 90,
      },
    }),
  );

  if (students[0]) {
    const code = await tally(ctx, "ReferralCode", () =>
      prisma.referralCode.create({
        data: {
          teacherId: teacher.id,
          ownerStudentId: students[0]!.id,
          code: `REF-${students[0]!.id.slice(0, 6).toUpperCase()}`,
        },
      }),
    );

    // The reward the referrer earned, reserved for them alone.
    const reward = await tally(ctx, "DiscountCode", () =>
      prisma.discountCode.create({
        data: {
          teacherId: teacher.id,
          code: `THANKS-${students[0]!.id.slice(0, 5).toUpperCase()}`,
          kind: "fixed",
          amountMinorUnits: 15_000,
          currency,
          origin: "referral_referrer",
          reservedForStudentId: students[0]!.id,
          expiresAt: days(now, 90),
        },
      }),
    );

    const second = students[1] ?? students[0]!;
    const pkg = packages.find((p) => p.studentId === second.id) ?? packages[0];
    const pay = pkg ? payments.find((p) => p.packageId === pkg.id) : undefined;

    if (pkg && pay) {
      await tally(ctx, "Referral", () =>
        prisma.referral.create({
          data: {
            teacherId: teacher.id,
            referralCodeId: code.id,
            referredStudentId: second.id,
            packageId: pkg.id,
            paymentId: pay.id,
            referredDiscountMinorUnits: 15_000,
            currency,
            status: "rewarded",
            referrerRewardCodeId: reward.id,
            qualifiedAt: days(now, -9),
          },
        }),
      );

      await tally(ctx, "DiscountRedemption", () =>
        prisma.discountRedemption.create({
          data: {
            discountCodeId: promo[0]!.id,
            teacherId: teacher.id,
            studentId: second.id,
            packageId: pkg.id,
            paymentId: pay.id,
            amountMinorUnits: 12_000,
            currency,
          },
        }),
      );
    }
  }

  // --- Payout instrument. Wise is the only manual rail (D-145), and `kind`
  // stays an enum precisely so a fixture cannot invent a second one — which is
  // also why this only fills a gap rather than adding a second row: `seed.ts`
  // already gives the Wise-rail heroes an instrument through a nested
  // `payoutInstruments: { create }`, and a fixture that did not check would
  // collide on the one-per-teacher constraint. It did, on the first run.
  const hasInstrument = await prisma.teacherPayoutInstrument.count({
    where: { teacherId: teacher.id },
  });
  if (hasInstrument === 0) {
    await tally(ctx, "TeacherPayoutInstrument", () =>
      prisma.teacherPayoutInstrument.create({
        data: {
          teacherId: teacher.id,
          kind: "wise",
          enabled: false,
          accountHolder: "Seed Fixture",
          wiseEmail: `payouts.${teacher.id.slice(0, 6)}@example.test`,
        },
      }),
    );
  }

  // --- Marketing and acquisition.
  await tally(ctx, "TeacherMarketingProfile", () =>
    prisma.teacherMarketingProfile.create({
      data: {
        teacherId: teacher.id,
        differentiator: "Conversation-first, with the grammar arriving when it is needed.",
        weeklyMinutes: 90,
        goalNewStudentsPerMonth: 3,
        memeStyle: "varied",
      },
    }),
  );

  const communities = await tally(ctx, "TeacherShareGroup", async () =>
    Promise.all(
      COMMUNITIES.map((c, i) =>
        prisma.teacherShareGroup.create({
          data: {
            teacherId: teacher.id,
            name: c.name,
            platform: c.platform,
            // ⚠️ `unknown` is the default and the safe one — a promotional kind
            // is never planned into a community whose policy is `prohibited` or
            // `unknown`. The fixtures deliberately include one of each so the
            // planner's safety gate is exercised rather than assumed.
            promoPolicy: c.promoPolicy,
            sortOrder: i,
            url: `https://example.test/community/${i}`,
            audienceNote: i === 0 ? "Large, but link-posting is against the rules." : null,
          },
        }),
      ),
    ),
  );

  const image = await tally(ctx, "SocialPreviewImage", () =>
    prisma.socialPreviewImage.create({
      data: {
        teacherId: teacher.id,
        source: "template",
        angle: "tip",
        topic: "ser vs. estar",
        storagePath: `social/${teacher.id}/ser-estar.png`,
        width: 1200,
        height: 630,
      },
    }),
  );

  await tally(ctx, "SocialPreview", () =>
    prisma.socialPreview.create({
      data: {
        teacherId: teacher.id,
        shareGroupId: communities[2]!.id,
        imageId: image.id,
        caption: "Two verbs, one English word, and the mistake everybody makes.",
      },
    }),
  );

  const plan = await tally(ctx, "MarketingPlan", () =>
    prisma.marketingPlan.create({
      data: {
        teacherId: teacher.id,
        weekStart: days(now, -(now.getUTCDay() || 7) + 1),
        weeklyMinutes: 90,
      },
    }),
  );

  const activities = await tally(ctx, "MarketingActivity", async () =>
    Promise.all(
      [
        {
          kind: "tip_post",
          platform: "instagram",
          status: "done" as const,
          title: "Ser vs. estar in ten seconds",
        },
        {
          kind: "ask_for_referral",
          platform: "email",
          status: "ready" as const,
          title: "Ask two students",
        },
        {
          kind: "answer_question",
          platform: "reddit",
          status: "planned" as const,
          title: "Answer, do not link",
        },
        {
          kind: "tip_post",
          platform: "facebook",
          status: "skipped" as const,
          title: "Skipped — policy prohibits",
        },
      ].map((a, i) =>
        prisma.marketingActivity.create({
          data: {
            teacherId: teacher.id,
            planId: plan.id,
            communityId: i >= 2 ? communities[i - 1]?.id : null,
            kind: a.kind,
            platform: a.platform,
            status: a.status,
            title: a.title,
            body: "Drafted by the teacher; the planner decides the work, never the words.",
            trackingCode: `t${i}${teacher.id.slice(0, 4)}`,
            imageId: i === 0 ? image.id : null,
            studentId: a.kind === "ask_for_referral" ? (students[0]?.id ?? null) : null,
            completedAt: a.status === "done" ? days(now, -3) : null,
          },
        }),
      ),
    ),
  );

  // The funnel ledger. Written best-effort in production and never inside a
  // payment transaction (a failed statement poisons a Postgres transaction even
  // when the JS error is caught) — the fixtures mirror the shape it produces.
  await tally(ctx, "AcquisitionEvent", async () =>
    Promise.all(
      [
        { kind: "visit" as const, source: "instagram", medium: "social", n: 18 },
        { kind: "enquiry" as const, source: "instagram", medium: "social", n: 4 },
        { kind: "booking" as const, source: "referral", medium: "word_of_mouth", n: 2 },
        { kind: "purchase" as const, source: "referral", medium: "word_of_mouth", n: 1 },
      ].flatMap((e) =>
        Array.from({ length: e.n }, (_, i) =>
          prisma.acquisitionEvent.create({
            data: {
              teacherId: teacher.id,
              kind: e.kind,
              source: e.source,
              medium: e.medium,
              campaign: "week-of-practice",
              occurredAt: days(now, -(i % 21) - 1),
              visitorHash: `v${(i * 7919).toString(16)}`,
              activityId: activities[0]!.id,
              communityId: communities[2]!.id,
              viaReferral: e.source === "referral",
              ...(e.kind === "purchase"
                ? { amountMinorUnits: templates[0]?.priceMinorUnits ?? 130_000, currency }
                : {}),
            },
          }),
        ),
      ),
    ),
  );

  // --- Notifications and push, both channels and several terminal states.
  if (students[0]) {
    await tally(ctx, "Notification", async () =>
      Promise.all(
        [
          { channel: "email" as const, template: "booking_confirmation", status: "sent" as const },
          {
            channel: "push" as const,
            template: "class_reminder_24h",
            status: "delivered" as const,
          },
          { channel: "email" as const, template: "payment_received", status: "sent" as const },
          {
            channel: "push" as const,
            template: "homework_feedback_ready",
            status: "failed" as const,
          },
          { channel: "email" as const, template: "package_expiring", status: "queued" as const },
          {
            channel: "push" as const,
            template: "class_reminder_1h",
            status: "suppressed" as const,
          },
        ].map((n, i) =>
          prisma.notification.create({
            data: {
              teacherId: teacher.id,
              recipientType: i % 3 === 0 ? "teacher" : "student",
              recipientId: i % 3 === 0 ? teacher.id : students[0]!.id,
              channel: n.channel,
              templateName: n.template,
              status: n.status,
              languageCode: i % 2 === 0 ? "en" : "es-MX",
              metadata: { seeded: true } satisfies Prisma.InputJsonValue,
              createdAt: days(now, -i - 1),
              sentAt: ["sent", "delivered"].includes(n.status) ? days(now, -i - 1) : null,
              deliveredAt: n.status === "delivered" ? days(now, -i - 1) : null,
              failedAt: n.status === "failed" ? days(now, -i - 1) : null,
              error: n.status === "failed" ? "Push endpoint returned 410 Gone" : null,
              readAt: i < 2 ? days(now, -i) : null,
            },
          }),
        ),
      ),
    );

    await tally(ctx, "WebPushSubscription", async () =>
      Promise.all(
        [
          { who: "teacher" as const, id: teacher.id, revoked: false },
          { who: "student" as const, id: students[0]!.id, revoked: true },
        ].map((s, i) =>
          prisma.webPushSubscription.create({
            data: {
              recipientType: s.who,
              recipientId: s.id,
              // `endpoint` is globally unique, and a student can belong to
              // several teachers — so keying it on the recipient alone
              // collided on the second teacher that shared one.
              endpoint: `https://push.example.test/seed/${teacher.id.slice(0, 8)}/${s.id.slice(0, 12)}`,
              // Not keys. A real subscription's p256dh and auth are base64
              // secrets; these are labelled so nothing mistakes them for one.
              p256dh: "seed-fixture-not-a-real-key",
              auth: "seed-fixture-not-a-real-key",
              userAgent: i === 0 ? "Mozilla/5.0 (Macintosh)" : "Mozilla/5.0 (Android 14)",
              revokedAt: s.revoked ? days(now, -6) : null,
            },
          }),
        ),
      ),
    );
  }

  // --- The audit trail. `overrides` is append-only in production; the seed
  // already disables that guard to reset, and these are the rows a class-detail
  // page shows under "what was changed and why".
  if (packages[0]) {
    await tally(ctx, "Override", async () =>
      Promise.all(
        [
          {
            targetType: "package" as const,
            targetId: packages[0]!.id,
            action: "extend_expiry",
            reason: "Student travelling",
          },
          {
            targetType: "booking" as const,
            targetId: packages[0]!.id,
            action: "teacher_cancel",
            reason: "Teacher unwell",
          },
        ].map((o) =>
          prisma.override.create({
            data: {
              teacherId: teacher.id,
              targetType: o.targetType,
              targetId: o.targetId,
              action: o.action,
              reason: o.reason,
              beforeJson: { status: "active" } satisfies Prisma.InputJsonValue,
              afterJson: { status: "active", note: o.action } satisfies Prisma.InputJsonValue,
              createdAt: days(now, -11),
            },
          }),
        ),
      ),
    );
  }

  await tally(ctx, "IntroVideoAnalysis", () =>
    prisma.introVideoAnalysis.create({
      data: {
        teacherId: teacher.id,
        videoPath: `teacher-videos/${teacher.id}/intro.mp4`,
        status: "transcribed",
        language: "es",
        provider: "deepgram",
        transcript: { text: "Hola, soy profesora de español…" } satisfies Prisma.InputJsonValue,
        coachFeedback: {
          strengths: ["Warm opening", "Says who the class is for"],
          suggestions: ["Name a price", "End with one clear next step"],
        } satisfies Prisma.InputJsonValue,
      },
    }),
  );

  await tally(ctx, "ClassContentGeneration", async () =>
    Promise.all(
      [0, 1, 2].map((i) =>
        prisma.classContentGeneration.create({
          data: { teacherId: teacher.id, createdAt: days(now, -i - 1) },
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Platform-wide: created once, not per teacher.
// ---------------------------------------------------------------------------

async function seedPlatform(ctx: Ctx, teachers: { id: string }[], payments: { id: string }[]) {
  const { prisma, now } = ctx;
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  await tally(ctx, "PlatformExpense", async () =>
    Promise.all(
      [
        { vendor: "fly", label: "Fly.io", category: "hosting" as const, amount: 2_400 },
        { vendor: "neon", label: "Neon", category: "hosting" as const, amount: 1_900 },
        { vendor: "anthropic", label: "Anthropic", category: "ai" as const, amount: 3_100 },
        { vendor: "deepgram", label: "Deepgram", category: "ai" as const, amount: 900 },
        { vendor: "resend", label: "Resend", category: "email" as const, amount: 0 },
        { vendor: "sentry", label: "Sentry", category: "monitoring" as const, amount: 0 },
        { vendor: "cloudflare", label: "Cloudflare", category: "domain" as const, amount: 1_200 },
      ].flatMap((e) =>
        [0, 1, 2].map((back) =>
          prisma.platformExpense.create({
            data: {
              vendor: e.vendor,
              vendorLabel: e.label,
              category: e.category,
              amountMinorUnits: e.amount,
              currency: "GBP",
              periodMonth: new Date(
                Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - back, 1),
              ),
              // `platform_expenses` has no unique constraint and no owner FK,
              // so without this marker every reseed adds another 21 rows and
              // nothing fails — three runs left 63. The marker is what
              // `resetFixtures` deletes on.
              notes: FIXTURE_MARKER,
            },
          }),
        ),
      ),
    ),
  );

  await tally(ctx, "UsageInput", async () =>
    Promise.all(
      [
        { metric: "active_teachers", value: teachers.length },
        { metric: "lessons_delivered", value: 128 },
        { metric: "ai_tokens_millions", value: 4.2 },
        { metric: "transcription_minutes", value: 640 },
      ].flatMap((u) =>
        [0, 1, 2].map((back) =>
          prisma.usageInput.create({
            data: {
              metric: u.metric,
              value: u.value * (1 - back * 0.12),
              periodMonth: new Date(
                Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - back, 1),
              ),
              source: FIXTURE_MARKER,
            },
          }),
        ),
      ),
    ),
  );

  await tally(ctx, "EconomicsAssumptions", () =>
    prisma.economicsAssumptions.upsert({
      where: { id: "default" },
      update: {},
      create: {
        id: "default",
        fxUsdToGbp: 0.79,
        fxMxnToGbp: 0.042,
        fxEurToGbp: 0.85,
        allocationBasis: "active_teachers",
        fxAsOf: days(now, -1),
      },
    }),
  );

  await tally(ctx, "AlphaAllowlistEntry", async () =>
    Promise.all(
      ["early.one@example.test", "early.two@example.test"].map((email, i) =>
        prisma.alphaAllowlistEntry.create({
          data: { email, addedBy: FIXTURE_MARKER, note: i === 0 ? "First cohort" : null },
        }),
      ),
    ),
  );

  await tally(ctx, "UatChecklistState", () =>
    prisma.uatChecklistState.upsert({
      where: { targetEnv: "preview" },
      update: {},
      create: {
        targetEnv: "preview",
        checkedItems: { A1: true, A2: true, B1: false } satisfies Prisma.InputJsonValue,
      },
    }),
  );

  // The webhook idempotency ledger. Every provider, so the admin view shows the
  // shape rather than one row.
  await tally(ctx, "WebhookEvent", async () =>
    Promise.all(
      [
        { provider: "stripe" as const, type: "checkout.session.completed" },
        { provider: "stripe" as const, type: "charge.refunded" },
        { provider: "stripe" as const, type: "account.updated" },
        { provider: "livekit" as const, type: "egress_ended" },
        { provider: "inngest" as const, type: "booking.canceled" },
      ].map((w, i) =>
        prisma.webhookEvent.create({
          data: {
            provider: w.provider,
            eventId: `evt_seed_${i}_${w.provider}`,
            eventType: w.type,
            receivedAt: days(now, -i - 1),
            processedAt: i === 4 ? null : days(now, -i - 1),
          },
        }),
      ),
    ),
  );

  // A dispute, because the state machine has eight states and nothing else
  // exercises any of them.
  if (payments[0]) {
    await tally(ctx, "Dispute", () =>
      prisma.dispute.create({
        data: {
          stripeDisputeId: "dp_seed_0001",
          stripeChargeId: "ch_seed_0001",
          stripePaymentIntentId: "pi_seed_0001",
          paymentId: payments[0]!.id,
          teacherId: teachers[0]?.id ?? null,
          amountMinorUnits: 130_000,
          currency: "MXN",
          reason: "product_not_received",
          status: "needs_response",
          evidenceDueBy: days(now, 5),
        },
      }),
    );
  }

  // The cost registry behind the admin economics page. Product code, idempotent,
  // and platform-wide — `main()` calls the same helper, which is why this can.
  //
  // It is here as well because `main()` is the CLI entry point and `seedAll()`
  // is what the integration harness calls: anything only `main()` does is
  // invisible to a test, which is exactly how these two models were missed
  // until the coverage guard named them.
  await tally(ctx, "Integration", () => ensureIntegrationsSeeded(prisma));

  // A FIXTURE admin, not a person. `main()` upserts the operator's and the
  // tester's real accounts and deliberately keeps them out of `seedAll` —
  // admins are hand-invited, never wiped like fixtures (D-25). This one is
  // generic by construction so the admin surfaces have a row to render without
  // putting anybody's address in the shared path.
  await tally(ctx, "AdminUser", () =>
    prisma.adminUser.upsert({
      where: { email: "admin.fixture@spiralclass.test" },
      update: {},
      create: { email: "admin.fixture@spiralclass.test", role: "superadmin" },
    }),
  );

  await tally(ctx, "AccountDeletionRequest", async () =>
    Promise.all(
      [
        { status: "pending" as const, scheduled: days(now, 25) },
        { status: "cancelled" as const, scheduled: days(now, -5) },
      ].map((r, i) =>
        prisma.accountDeletionRequest.create({
          data: {
            subjectType: "student",
            subjectId: randomUUID(),
            email: `deleting.${i}@example.test`,
            status: r.status,
            scheduledFor: r.scheduled,
            cancelledAt: r.status === "cancelled" ? days(now, -6) : null,
            reason: i === 0 ? "No longer studying" : null,
          },
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// better-auth's own tables. Inert by construction — see rule 2 in the header.
// ---------------------------------------------------------------------------

async function seedAuthArtefacts(ctx: Ctx, userIds: string[]) {
  const { prisma, now } = ctx;
  if (userIds.length === 0) return;

  // EXPIRED. A session row is a login; an unexpired one would make this file
  // the only place in the repository that ships a working credential.
  await tally(ctx, "Session", async () =>
    Promise.all(
      userIds.slice(0, 3).map((userId, i) =>
        prisma.session.create({
          data: {
            userId,
            token: `seed-expired-session-${i}-${userId.slice(0, 8)}`,
            expiresAt: days(now, -30),
            createdAt: days(now, -60),
            updatedAt: days(now, -60),
            ipAddress: "203.0.113.10",
            userAgent: "Mozilla/5.0 (Macintosh)",
          },
        }),
      ),
    ),
  );

  // A Google linkage with no usable token, so the "signed in with Google"
  // surface is not empty.
  await tally(ctx, "Account", () =>
    prisma.account.create({
      data: {
        userId: userIds[0]!,
        accountId: `seed-google-${userIds[0]!.slice(0, 8)}`,
        providerId: "google",
        scope: "openid email profile",
        createdAt: days(now, -90),
        updatedAt: days(now, -90),
      },
    }),
  );

  // ALREADY EXPIRED, so the code cannot be redeemed.
  await tally(ctx, "Verification", () =>
    prisma.verification.create({
      data: {
        identifier: "seed.expired@example.test",
        value: "seed-fixture-consumed",
        expiresAt: days(now, -1),
        createdAt: days(now, -1),
        updatedAt: days(now, -1),
      },
    }),
  );

  // Enrolled but with a visibly fake secret — enough for the admin security
  // page to show an enrolled account, useless as a second factor.
  await tally(ctx, "TwoFactor", () =>
    prisma.twoFactor.create({
      data: {
        userId: userIds[0]!,
        secret: "SEEDFIXTURENOTAREALTOTPSECRET",
        backupCodes: "seed-fixture-not-real-backup-codes",
        verified: true,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Decorates whatever `seedAll` has just built. Safe to call more than once only
 * after that function's cleanup has run — it creates rather than upserts,
 * because the teacher cascade is what makes the whole seed idempotent and
 * duplicating that logic here would be a second definition of "reset".
 */
export async function seedFixtures(prisma: PrismaClient, now = new Date()): Promise<FixtureCounts> {
  const ctx: Ctx = { prisma, now, counts: {} };

  const teachers = await prisma.teacher.findMany({
    where: { seededAt: { not: null } },
    select: {
      id: true,
      targetLanguage: true,
      pricingCurrency: true,
      locale: true,
      packageTemplates: { select: { id: true, priceMinorUnits: true } },
      teacherStudents: { select: { student: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (teachers.length === 0) return ctx.counts;

  // Before anything is written: clear what the teacher cascade cannot reach.
  await resetFixtures(
    ctx,
    teachers.map((t) => t.id),
  );

  for (const teacher of teachers) {
    const students = teacher.teacherStudents.map((ts) => ts.student);
    const packages = await prisma.package.findMany({
      where: { teacherId: teacher.id },
      select: { id: true, studentId: true },
    });
    const payments = await prisma.payment.findMany({
      where: { package: { teacherId: teacher.id } },
      select: { id: true, packageId: true },
    });

    const { levels, focusTags } = await seedTaxonomy(ctx, teacher);
    const materials = await seedMaterials(ctx, teacher, levels, focusTags);

    // The decorated students and the decorated classes must be THE SAME
    // students, or the student record shows "None confirmed yet" while the
    // insights sit on somebody else's classes — which is what the first run
    // produced, and which looks exactly like a bug in the product.
    //
    // Capped at two classes each: past that it is the same shape repeated, and
    // the seed is already the slowest step in `pnpm setup`.
    //
    // EVERY student, not a slice. `teacherStudents` comes back unordered, so
    // decorating "the first three" left the rest with an empty Learning tab —
    // and which three varied between runs, which is worse than either.
    // Teachers here have one or two students; the cap was solving a problem
    // that does not exist.
    let classIndex = 0;
    for (const [i, student] of students.entries()) {
      const completed = await prisma.booking.findMany({
        where: { teacherId: teacher.id, studentId: student.id, status: "completed" },
        select: { id: true, studentId: true, scheduledStart: true },
        orderBy: { scheduledStart: "desc" },
        take: 2,
      });
      for (const booking of completed) {
        await seedClassArtefacts(ctx, teacher, booking, materials, classIndex);
        classIndex += 1;
      }
      await seedStudentArtefacts(ctx, teacher, student, materials, levels, i);
    }

    await seedTeacherOperations(
      ctx,
      teacher,
      students,
      teacher.packageTemplates,
      packages,
      payments,
    );
  }

  const allPayments = await prisma.payment.findMany({ select: { id: true }, take: 1 });
  await seedPlatform(ctx, teachers, allPayments);

  const users = await prisma.user.findMany({
    select: { id: true },
    take: 3,
    orderBy: { createdAt: "asc" },
  });
  await seedAuthArtefacts(
    ctx,
    users.map((u) => u.id),
  );

  return ctx.counts;
}
