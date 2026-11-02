import { profileSchema, type StudentProfile, type Trend } from "./profile";

// What the teacher's Learning profile tab shows, decided once and unit-tested:
// which entries are "speaking signals" (how she talks — fluency and
// comprehension) and which are "focus areas" (what she gets wrong), in what
// order, and what short hint rides along. Timestamps and full quotes are
// deliberately not part of the view: a teacher reading across a student's
// history wants the pattern, not the transcript line.

export const SIGNAL_CATEGORIES = ["fluency", "comprehension"] as const;

// A quote longer than this is cut. It is a reminder of the moment, not the record.
export const HINT_MAX_CHARS = 80;

export type ProfileRow = {
  category: string;
  skill: string;
  recurrenceCount: number;
  trend: Trend;
  hint: string | null;
};

export type ProfileView = {
  signals: ProfileRow[];
  focus: ProfileRow[];
  vocabulary: string[];
};

export function truncateHint(evidence: string | null, max = HINT_MAX_CHARS): string | null {
  const text = evidence?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const TREND_RANK: Record<Trend, number> = { focus: 0, new: 1, improving: 2 };

// Most recurrent first; an active "focus" outranks "new" and "improving" on ties.
function byImportance(a: ProfileRow, b: ProfileRow): number {
  return b.recurrenceCount - a.recurrenceCount || TREND_RANK[a.trend] - TREND_RANK[b.trend];
}

export function buildProfileView(raw: unknown): ProfileView {
  const parsed = raw ? profileSchema.safeParse(raw) : null;
  // A malformed or legacy-shaped row is "no profile", never a crash.
  const profile: StudentProfile | null = parsed?.success ? parsed.data : null;
  const signals: ProfileRow[] = [];
  const focus: ProfileRow[] = [];
  if (profile) {
    for (const [category, skills] of Object.entries(profile.byCategory)) {
      const isSignal = (SIGNAL_CATEGORIES as readonly string[]).includes(category);
      for (const [skill, entry] of Object.entries(skills)) {
        (isSignal ? signals : focus).push({
          category,
          skill,
          recurrenceCount: entry.recurrenceCount,
          trend: entry.trend,
          hint: truncateHint(entry.lastEvidence),
        });
      }
    }
  }
  return {
    signals: signals.sort(byImportance),
    focus: focus.sort(byImportance),
    vocabulary: profile?.vocabulary.map((v) => v.term) ?? [],
  };
}
