// Puts the seeded local database in the state the landing-page clips are
// recorded from (scripts/marketing/record.ts). It adds, on top of
// scripts/seed.ts, the rows a teacher only has after real classes: lesson
// findings for the pipeline to show, a pre-class brief, a vocabulary queue, a
// homework submission waiting for review, a message thread, class notes and
// class materials. Every row is fixture data for Alicia Moreno and Carlos Ruiz,
// the pair `pnpm call:local` puts in a room, so the clips and the call are one
// story.
//
//   pnpm --filter spiralclass-web demo:fixtures
//
// Idempotent: each section deletes what an earlier run wrote before writing
// again, keyed on the marker text below, so the seed's own rows are untouched.
// Local only — it reuses the seed's production guard and additionally refuses
// any database whose host is not local.
import { PrismaClient } from "@prisma/client";
import { addDays, subDays } from "date-fns";
import { pgAdapter } from "@/lib/db-pool";
import { recomputeStudentProfile } from "@/lib/lesson-notes/profile";
import { seedVocabularyReviews } from "@/lib/lesson-notes/srs";
import type { Brief } from "@/lib/lesson-notes/brief";
import { assertNotProductionTarget } from "../seed";

const TEACHER_EMAIL = "alicia.moreno@spiralclass.test";
const STUDENT_EMAIL = "carlos@alumno.test";
// A re-run deletes only rows whose text matches what this file writes, so the
// seed's own rows are never touched.
const CONTENT_LABEL = "El imperfecto: cómo era tu infancia";
const REUSABLE_LABEL = "Vocabulario del mercado";
const ASSIGNMENT_TITLE = "Ocho frases en imperfecto";

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`demo fixtures only run against a local database (host: ${host})`);
  }
}

async function main(): Promise<void> {
  assertNotProductionTarget();
  assertLocalDatabase();
  const prisma = new PrismaClient({ adapter: pgAdapter(process.env.DATABASE_URL!) });
  const now = new Date();

  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { email: TEACHER_EMAIL },
    select: { id: true },
  });
  const student = await prisma.student.findFirstOrThrow({
    where: { email: STUDENT_EMAIL },
    select: { id: true },
  });
  const teacherId = teacher.id;
  const studentId = student.id;

  const bookings = await prisma.booking.findMany({
    where: { teacherId, studentId, status: { in: ["completed", "scheduled"] } },
    orderBy: { scheduledStart: "asc" },
    select: { id: true, status: true, scheduledStart: true },
  });
  const completed = bookings.filter((b) => b.status === "completed");
  const scheduled = bookings.filter((b) => b.status === "scheduled");
  if (completed.length < 2 || scheduled.length < 1) {
    throw new Error("expected two completed and one scheduled class — run `pnpm seed` first");
  }
  const [older, newer] = completed.slice(-2);
  // The call script moves the pair's EARLIEST scheduled class to now, so that
  // is the one the call, the notes and the class material belong to.
  const next = scheduled[0];

  // Consent is what lets the pipeline keep anything (D-22); the seed grants it
  // for this pair, and the progress screen needs the student to share it too.
  await prisma.teacherStudent.update({
    where: { teacherId_studentId: { teacherId, studentId } },
    data: {
      shareProgress: true,
      insightsConsentAt: subDays(now, 30),
      captionsConsentAt: subDays(now, 30),
      interests: "Travelling in Oaxaca, cooking, football",
      goals: "Hold a relaxed conversation with his partner's family by December",
    },
  });

  // --- Lesson findings: what the after-class pipeline writes, in the shape
  // the teacher confirms or dismisses. The older class's findings are already
  // confirmed (they feed the profile); the newest class's are waiting, so the
  // clip can show her confirming one.
  const findings: Array<{
    bookingId: string;
    category: "grammar" | "vocabulary" | "pronunciation" | "fluency" | "comprehension";
    skill: string;
    summary: string;
    evidence: string;
    suggestion: string;
    atMs: number;
    confirmed: boolean;
  }> = [
    {
      bookingId: older.id,
      category: "grammar",
      skill: "Ser vs. estar",
      summary: `Uses "ser" for temporary states`,
      evidence: "Mi hermana es enferma hoy.",
      suggestion: "Está enferma — a state, not a trait. Drill with five feelings.",
      atMs: 312_000,
      confirmed: true,
    },
    {
      bookingId: older.id,
      category: "vocabulary",
      skill: "food and markets",
      summary: `Reached for English market words`,
      evidence: "Compré... um, chili peppers... en el mercado.",
      suggestion: "chiles, jitomate, cilantro — the Oaxaca market list.",
      atMs: 760_000,
      confirmed: true,
    },
    {
      bookingId: older.id,
      category: "pronunciation",
      skill: "rolled r",
      summary: `Single r for rr in "perro", "carro"`,
      evidence: "pero (meant perro)",
      suggestion: "Minimal pairs pero/perro, caro/carro, two minutes at the start.",
      atMs: 1_420_000,
      confirmed: true,
    },
    {
      bookingId: newer.id,
      category: "grammar",
      skill: "preterite vs imperfect",
      summary: `Preterite where the background needs imperfect`,
      evidence: "Cuando fui niño, jugué fútbol todos los días.",
      suggestion: "Era niño, jugaba — habit in the past takes the imperfect.",
      atMs: 480_000,
      confirmed: false,
    },
    {
      bookingId: newer.id,
      category: "fluency",
      skill: "connectors",
      summary: `Longer answers now, still joined with "y... y..."`,
      evidence: "Fui al mercado y compré chiles y después cociné y...",
      suggestion: "Introduce luego, entonces, así que; ask for one story using all three.",
      atMs: 905_000,
      confirmed: false,
    },
    {
      bookingId: newer.id,
      category: "comprehension",
      skill: "fast speech",
      summary: `Asked for a repeat on two questions at natural speed`,
      evidence: "¿Perdón? ¿Puedes repetir?",
      suggestion: "Keep one question per class at full speed; slow only on the repeat.",
      atMs: 1_610_000,
      confirmed: false,
    },
    {
      bookingId: newer.id,
      category: "vocabulary",
      skill: "cooking verbs",
      summary: `New verbs used correctly: picar, freír, hervir`,
      evidence: "Primero pico la cebolla y luego la frío.",
      suggestion: "Add asar and sazonar next class.",
      atMs: 1_200_000,
      confirmed: false,
    },
  ];
  await prisma.lessonInsight.deleteMany({
    where: { teacherId, summary: { in: findings.map((f) => f.summary) } },
  });
  await prisma.lessonInsight.createMany({
    data: findings.map((f) => ({
      bookingId: f.bookingId,
      teacherId,
      category: f.category,
      skill: f.skill,
      summary: f.summary,
      evidence: f.evidence,
      suggestion: f.suggestion,
      atMs: f.atMs,
      source: "ai",
      confirmedAt: f.confirmed ? subDays(now, 6) : null,
    })),
  });
  await recomputeStudentProfile(prisma, { teacherId, studentId });

  // --- The vocabulary queue the student reviews (SM-2). Seeded the way the
  // pipeline seeds it: from confirmed vocabulary.
  await prisma.vocabularyReview.deleteMany({ where: { teacherId, studentId } });
  await seedVocabularyReviews(prisma, {
    teacherId,
    studentId,
    terms: ["chiles", "jitomate", "cilantro", "picar", "freír", "hervir", "mercado", "receta"],
    now: subDays(now, 1),
  });

  // --- The pre-class brief for the next class, in the shape brief.ts parses.
  const brief: Brief = {
    summary:
      'Carlos is speaking in longer stretches and his market vocabulary stuck. Two things to work on today: the imperfect for past habits, and joining ideas with something other than "y".',
    focus: [
      {
        skill: "preterite vs imperfect",
        category: "grammar",
        why: 'Last class: "Cuando fui niño, jugué fútbol todos los días."',
        suggestedCue: "Ask what he did every summer as a child; listen for era / jugaba.",
      },
      {
        skill: "connectors",
        category: "fluency",
        why: 'Stories still chain with "y"; he has the content, not the glue.',
        suggestedCue: "Give him luego, entonces, así que on a card; one story using all three.",
      },
      {
        skill: "rolled r",
        category: "pronunciation",
        why: "Confirmed two classes ago; not yet heard clean in free speech.",
        suggestedCue: "Two minutes of pero/perro, caro/carro to warm up.",
      },
    ],
    vocabulary: ["asar", "sazonar", "la receta", "el comal"],
  };
  await prisma.lessonBrief.upsert({
    where: { bookingId: next.id },
    create: { bookingId: next.id, teacherId, content: brief, model: "claude-haiku-4-5" },
    update: { content: brief, model: "claude-haiku-4-5", generatedAt: now },
  });

  // --- Lesson notes on the next class: private cues and student-facing
  // instructions, the two columns the call shows.
  const notes = [
    {
      bookingId: next.id,
      teacherId,
      audience: "teacher",
      position: 1,
      body: `Warm-up: pero / perro, caro / carro`,
    },
    {
      bookingId: next.id,
      teacherId,
      audience: "teacher",
      position: 2,
      body: `Childhood summers → era, jugaba, íbamos`,
    },
    {
      bookingId: next.id,
      teacherId,
      audience: "teacher",
      position: 3,
      body: `One story with luego / entonces / así que`,
    },
    {
      bookingId: next.id,
      teacherId,
      audience: "student",
      position: 1,
      body: `Trae una receta que cocinas en casa`,
    },
    {
      bookingId: next.id,
      teacherId,
      audience: "student",
      position: 2,
      body: `Repasa el vocabulario del mercado`,
    },
  ] as const;
  await prisma.lessonNote.deleteMany({
    where: { teacherId, body: { in: notes.map((n) => n.body) } },
  });
  await prisma.lessonNote.createMany({ data: [...notes] });

  // --- Class content for the next class (AI-drafted shape, saved after her
  // review) and a reusable library material attached to it.
  await prisma.libraryMaterial.deleteMany({
    where: { teacherId, label: { in: [CONTENT_LABEL, REUSABLE_LABEL] } },
  });
  const content = await prisma.libraryMaterial.create({
    data: {
      teacherId,
      bookingId: next.id,
      visibility: "exact",
      position: 0,
      label: CONTENT_LABEL,
      contentSource: "ai",
      body: [
        "# El imperfecto: cómo era tu infancia",
        "",
        "## Calentamiento (5 min)",
        "Pronuncia en voz alta: **pero / perro**, **caro / carro**, **coro / corro**.",
        "",
        "## El imperfecto para hábitos del pasado",
        "| Pretérito | Imperfecto |",
        "|---|---|",
        "| Ayer **jugué** fútbol. | De niño **jugaba** fútbol todos los días. |",
        "| El sábado **fui** al mercado. | Cada domingo **iba** al mercado con mi abuela. |",
        "",
        "## Práctica (15 min)",
        "Cuenta cómo eran tus veranos de niño. Usa al menos tres de estos verbos: *era, vivía, jugaba, íbamos, comíamos*.",
        "",
        "## Conectores",
        "Une tus ideas con **luego**, **entonces** y **así que** en lugar de *y*.",
        "",
        "> [!homework]",
        "> Escribe ocho frases sobre tu infancia en imperfecto y mándamelas antes de la próxima clase.",
      ].join("\n"),
    },
  });
  const level = await prisma.level.findFirst({
    where: { teacherId, label: "B1" },
    select: { id: true },
  });
  const reusable = await prisma.libraryMaterial.create({
    data: {
      teacherId,
      levelId: level?.id ?? null,
      visibility: "at_or_below",
      position: 1,
      label: REUSABLE_LABEL,
      contentSource: "manual",
      body: [
        "# Vocabulario del mercado",
        "",
        "- **el jitomate** — tomato",
        "- **los chiles** — chillies",
        "- **el cilantro** — coriander",
        "- **el comal** — flat griddle",
        "- **picar** — to chop",
        "- **freír** — to fry",
        "- **hervir** — to boil",
        "",
        "## Diálogo",
        "— ¿A cómo el kilo de jitomate?",
        "— A treinta pesos, güerito.",
      ].join("\n"),
    },
  });
  await prisma.bookingLibraryMaterial.upsert({
    where: { bookingId_libraryMaterialId: { bookingId: next.id, libraryMaterialId: reusable.id } },
    create: { bookingId: next.id, libraryMaterialId: reusable.id, sendTiming: "t_24h" },
    update: {},
  });

  // --- Homework: the newest completed class's assignment, submitted and
  // waiting for her review.
  await prisma.assignment.deleteMany({ where: { teacherId, title: ASSIGNMENT_TITLE } });
  const assignment = await prisma.assignment.create({
    data: {
      bookingId: newer.id,
      teacherId,
      title: ASSIGNMENT_TITLE,
      instructions:
        "Escribe ocho frases sobre tu infancia usando el imperfecto. Intenta usar luego, entonces y así que.",
      dueAt: addDays(now, 1),
      allowResubmission: true,
      sourceMaterialId: content.id,
    },
  });
  const submission = await prisma.homeworkSubmission.create({
    data: {
      assignmentId: assignment.id,
      studentId,
      teacherId,
      status: "submitted",
      submittedAt: subDays(now, 1),
      textResponse: [
        "Cuando era niño, vivía en Guadalajara con mis abuelos.",
        "Todos los veranos íbamos a la playa en Puerto Vallarta.",
        "Mi abuela cocinaba pozole cada domingo, entonces toda la familia venía a comer.",
        "Yo jugaba fútbol en la calle con mis primos hasta que era de noche.",
        "No tenía teléfono, así que leía muchos cómics.",
        "Mi papá trabajaba mucho, luego llegaba a casa muy cansado.",
        "Me gustaba mucho la escuela porque mis amigos estaban allí.",
        "Fui muy feliz en esa época.",
      ].join("\n"),
    },
  });
  await prisma.homeworkAttempt.create({
    data: {
      submissionId: submission.id,
      attemptNumber: 1,
      textResponse: submission.textResponse,
      submittedAt: subDays(now, 1),
    },
  });

  // --- A message thread.
  const thread: Array<{ role: "teacher" | "student"; body: string; minutesAgo: number }> = [
    {
      role: "student",
      body: `Hola Alicia, ya mandé la tarea. ¿Está bien usar "así que" al final de la frase?`,
      minutesAgo: 1_400,
    },
    {
      role: "teacher",
      body: `¡Hola Carlos! Sí, perfecto. Lo vemos mañana con calma. Trae una receta que cocines en casa 🍳`,
      minutesAgo: 1_320,
    },
    {
      role: "student",
      body: `Va, llevo la de los chilaquiles de mi abuela`,
      minutesAgo: 1_300,
    },
    {
      role: "teacher",
      body: `Esa quiero aprenderla yo también. Nos vemos a las 5 ✨`,
      minutesAgo: 60,
    },
  ];
  await prisma.message.deleteMany({
    where: { teacherId, studentId, body: { in: thread.map((m) => m.body) } },
  });
  for (const m of thread) {
    await prisma.message.create({
      data: {
        teacherId,
        studentId,
        senderRole: m.role,
        body: m.body,
        createdAt: new Date(now.getTime() - m.minutesAgo * 60_000),
        readAt: m.minutesAgo > 100 ? new Date(now.getTime() - (m.minutesAgo - 5) * 60_000) : null,
      },
    });
  }

  // --- Get students: the four things the planner cannot infer.
  await prisma.teacherMarketingProfile.upsert({
    where: { teacherId },
    create: {
      teacherId,
      audiences: ["expats", "travellers"],
      learnerLocations: ["Oaxaca", "Mexico City", "online"],
      levels: ["a1", "a2", "b1"],
      differentiator: "Relaxed conversation classes that get you talking from the first day.",
      weeklyMinutes: 60,
      goalNewStudentsPerMonth: 2,
      memeStyle: "varied",
    },
    update: { weeklyMinutes: 60, goalNewStudentsPerMonth: 2 },
  });

  console.log(
    `demo fixtures written for ${TEACHER_EMAIL} / ${STUDENT_EMAIL}: ` +
      `${findings.length} findings, brief + notes + content on ${next.id}, homework on ${newer.id}`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
