/**
 * Financial Intelligence — usage extractor (D-86).
 *
 * Computes the real values for the 9 economics USAGE_METRICS from the live
 * database for one calendar month, so the /admin/economics Usage tab is seeded
 * with facts instead of guesses. READ-ONLY — it never writes.
 *
 * Run against the deployed DB with the matching env file, e.g.:
 *   pnpm --filter spiralclass-web economics:usage:preview            # last complete month
 *   pnpm --filter spiralclass-web economics:usage:preview 2026-06    # a specific month
 *
 * It prints a human table + a JSON block of `{ metric: value }` you paste into
 * the Usage tab (values are integers/decimals, NOT money). `storage_gb` is not
 * in Postgres — read it from the Cloudflare R2 (and Neon) dashboards and enter
 * it by hand; the script leaves it null.
 *
 * Meter notes (see the KNOWN_INTEGRATIONS "METER CONFLATION" comment):
 *   • ai_generations counts ONLY Anthropic text generations (class content,
 *     summaries, AI insights, briefs). ASR (transcripts, intro-video analysis),
 *     Azure pronunciation, and TTS podcasts are NOT counted here — they bill on
 *     minutes / their own subscription.
 *   • video_minutes is the sum of two physically different sources, printed
 *     broken out: lesson-audio transcription minutes (Deepgram) and
 *     call-recording minutes (LiveKit). Deepgram/Azure really see the
 *     lesson-audio minutes; LiveKit sees the call minutes. Split the meter if
 *     you need per-provider precision.
 *   • emails counts Notification rows with channel='email'. This is a LOWER
 *     BOUND — auth emails (OTP/magic-link) go straight through Resend/SES and
 *     may not create Notification rows. Cross-check the provider dashboard.
 */
import { PrismaClient } from "@prisma/client";
import { envAdapter } from "@/lib/db-pool";

const prisma = new PrismaClient({ adapter: envAdapter() });

// [start, end) UTC month window. Arg "YYYY-MM" → that month; else the last
// COMPLETE calendar month relative to now.
function resolveWindow(arg: string | undefined): { start: Date; end: Date; label: string } {
  if (arg) {
    const m = /^(\d{4})-(\d{2})$/.exec(arg);
    if (!m) throw new Error(`Bad month "${arg}" — expected YYYY-MM`);
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    return {
      start: new Date(Date.UTC(y, mo, 1)),
      end: new Date(Date.UTC(y, mo + 1, 1)),
      label: arg,
    };
  }
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); // first of THIS month
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)); // first of last month
  const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start, end, label };
}

async function callRecordingMinutes(start: Date, end: Date): Promise<number> {
  // Duration = ended_at − started_at; CallRecording has no duration column.
  const rows = await prisma.$queryRaw<{ minutes: number }[]>`
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0), 0)::float AS minutes
    FROM call_recordings
    WHERE created_at >= ${start} AND created_at < ${end} AND ended_at IS NOT NULL
  `;
  return rows[0]?.minutes ?? 0;
}

async function main() {
  const { start, end, label } = resolveWindow(process.argv[2]);
  const created = { createdAt: { gte: start, lt: end } };

  const [
    teachers,
    students,
    lessons,
    classContent,
    summaries,
    aiInsights,
    briefs,
    lessonAudioMs,
    callMinutes,
    emails,
    notifications,
    recordings,
  ] = await Promise.all([
    // Stocks (point-in-time): active = onboarded teachers.
    prisma.teacher.count({ where: { onboardingCompleteAt: { not: null } } }),
    prisma.student.count(),
    // Delivered lessons this month.
    prisma.booking.count({ where: { status: "completed", completedAt: { gte: start, lt: end } } }),
    // ai_generations components (Anthropic text-gen only).
    prisma.classContentGeneration.count({ where: created }),
    prisma.lessonSummary.count({ where: created }),
    prisma.lessonInsight.count({ where: { source: "ai", ...created } }),
    prisma.lessonBrief.count({ where: { generatedAt: { gte: start, lt: end } } }),
    // video_minutes components.
    prisma.lessonAudio.aggregate({ _sum: { durationMs: true }, where: created }),
    callRecordingMinutes(start, end),
    // emails vs push.
    prisma.notification.count({ where: { channel: "email", ...created } }),
    prisma.notification.count({ where: { channel: "push", ...created } }),
    prisma.callRecording.count({ where: created }),
  ]);

  const aiGenerations = classContent + summaries + aiInsights + briefs;
  const transcriptionMin = Math.round((lessonAudioMs._sum.durationMs ?? 0) / 60000);
  const callMin = Math.round(callMinutes);
  const videoMinutes = transcriptionMin + callMin;

  const metrics = {
    teachers,
    students,
    lessons,
    ai_generations: aiGenerations,
    video_minutes: videoMinutes,
    storage_gb: null as number | null, // NOT in Postgres — enter from R2/Neon dashboards
    emails,
    notifications,
    recordings,
  };

  console.log(
    `\nEconomics usage — ${label} (UTC ${start.toISOString().slice(0, 10)} .. ${end
      .toISOString()
      .slice(0, 10)})\n`,
  );
  const table: Array<[string, string]> = [
    ["teachers (active/onboarded, stock)", String(teachers)],
    ["students (stock)", String(students)],
    ["lessons (completed this month)", String(lessons)],
    ["ai_generations (Anthropic)", String(aiGenerations)],
    ["  · class content", String(classContent)],
    ["  · summaries", String(summaries)],
    ["  · ai insights", String(aiInsights)],
    ["  · briefs", String(briefs)],
    ["video_minutes (total)", String(videoMinutes)],
    ["  · lesson-audio (Deepgram)", String(transcriptionMin)],
    ["  · call recordings (LiveKit)", String(callMin)],
    ["storage_gb", "— enter manually from R2/Neon dashboards"],
    ["emails (Notification channel=email; LOWER BOUND)", String(emails)],
    ["notifications (push)", String(notifications)],
    ["recordings (CallRecording count)", String(recordings)],
  ];
  const w = Math.max(...table.map(([k]) => k.length));
  for (const [k, v] of table) console.log(`  ${k.padEnd(w)}  ${v}`);

  console.log(`\nPaste into the Usage tab (metric → value):\n`);
  console.log(JSON.stringify(metrics, null, 2));
  console.log("");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
