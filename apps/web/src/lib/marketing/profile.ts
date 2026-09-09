import "server-only";
import { z } from "zod";
import {
  DEFAULT_MEME_STYLE,
  DEFAULT_WEEKLY_MINUTES,
  isMemeStyle,
  languageName,
  TEACHER_MEME_BRIEF_MAX_CHARS,
  type ContentCapabilities,
  type MemeStyle,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";

// The teacher's acquisition context.
//
// The design constraint that shaped this module: a teacher will not fill in a
// twenty-field marketing questionnaire, and a product that needs one has
// already lost. So there are FOUR editable things — who she wants, where they
// are, what makes her different, and how much time she has — and everything
// else is read off the account she has already built.
//
// `buildTeacherContext` is that inference. It is the single input to content
// generation and to the planner, so what the model can say and what the
// planner can schedule are both bounded by facts that are actually true.

export const MARKETING_PROFILE_LIST_MAX = 6;
export const MARKETING_PROFILE_ITEM_MAX = 40;
export const DIFFERENTIATOR_MAX = 240;

const listField = z
  .array(z.string().trim().min(1).max(MARKETING_PROFILE_ITEM_MAX))
  .max(MARKETING_PROFILE_LIST_MAX)
  .default([]);

export const marketingProfileInputSchema = z.object({
  audiences: listField,
  learnerLocations: listField,
  levels: listField,
  // Empty maps to undefined BEFORE the length check, so clearing the textarea
  // clears the field rather than storing "". Ordering matters: `.optional()`
  // first would accept "" as a valid string and never reach the transform.
  differentiator: z
    .string()
    .trim()
    .transform((v) => (v.length === 0 ? undefined : v))
    .pipe(z.string().max(DIFFERENTIATOR_MAX).optional())
    .optional(),
  weeklyMinutes: z.coerce.number().int().min(15).max(300).default(DEFAULT_WEEKLY_MINUTES),
  goalNewStudentsPerMonth: z.coerce.number().int().min(1).max(50).default(2),
});

/**
 * Her general image-generation instructions, saved on their own.
 *
 * A SEPARATE schema from the profile above, deliberately. The two are edited
 * from different screens — the acquisition profile from
 * /get-students/profile, this from the Communities page beside her memes —
 * and a shared schema would make each form capable of blanking the other's
 * fields on submit, which is exactly the class of bug the `optionalField`
 * helper in app/actions/marketing.ts exists to paper over.
 */
export const memeSettingsInputSchema = z.object({
  memeBrief: z
    .string()
    .trim()
    .transform((v) => (v.length === 0 ? undefined : v))
    .pipe(z.string().max(TEACHER_MEME_BRIEF_MAX_CHARS).optional())
    .optional(),
  // An unrecognised style degrades to the default rather than failing: a value
  // written by a newer deploy must not break an older one's save.
  memeStyle: z
    .string()
    .optional()
    .transform((v) => (isMemeStyle(v) ? v : DEFAULT_MEME_STYLE)),
});

export type MemeSettingsInput = z.infer<typeof memeSettingsInputSchema>;

export type MemeSettings = { memeBrief: string | null; memeStyle: MemeStyle };

export const DEFAULT_MEME_SETTINGS: MemeSettings = {
  memeBrief: null,
  memeStyle: DEFAULT_MEME_STYLE,
};

export type MarketingProfileInput = z.infer<typeof marketingProfileInputSchema>;

export type MarketingProfileView = Omit<MarketingProfileInput, "differentiator"> & {
  differentiator: string | null;
} & MemeSettings;

export const DEFAULT_MARKETING_PROFILE: MarketingProfileView = {
  audiences: [],
  learnerLocations: [],
  levels: [],
  differentiator: null,
  weeklyMinutes: DEFAULT_WEEKLY_MINUTES,
  goalNewStudentsPerMonth: 2,
  ...DEFAULT_MEME_SETTINGS,
};

/** Never null: an absent row IS the default profile, and the product works
 * fully without the teacher ever opening this screen. */
export async function getMarketingProfile(
  teacherId: string,
  db: PrismaClient = prisma,
): Promise<MarketingProfileView> {
  const row = await db.teacherMarketingProfile.findUnique({ where: { teacherId } });
  if (!row) return DEFAULT_MARKETING_PROFILE;
  return {
    audiences: row.audiences,
    learnerLocations: row.learnerLocations,
    levels: row.levels,
    differentiator: row.differentiator,
    weeklyMinutes: row.weeklyMinutes,
    goalNewStudentsPerMonth: row.goalNewStudentsPerMonth,
    memeBrief: row.memeBrief,
    memeStyle: isMemeStyle(row.memeStyle) ? row.memeStyle : DEFAULT_MEME_STYLE,
  };
}

/** Just the image half, for the generation path — which needs two columns and
 * should not pay for five joins to read them. */
export async function getMemeSettings(
  teacherId: string,
  db: PrismaClient = prisma,
): Promise<MemeSettings> {
  const row = await db.teacherMarketingProfile.findUnique({
    where: { teacherId },
    select: { memeBrief: true, memeStyle: true },
  });
  if (!row) return DEFAULT_MEME_SETTINGS;
  return {
    memeBrief: row.memeBrief,
    memeStyle: isMemeStyle(row.memeStyle) ? row.memeStyle : DEFAULT_MEME_STYLE,
  };
}

/** Upsert so a teacher who has never opened the acquisition profile can still
 * set her image preferences — the row is created with defaults for everything
 * else, exactly as saveMarketingProfile does in the other direction. */
export async function saveMemeSettings(teacherId: string, input: MemeSettingsInput): Promise<void> {
  const data = { memeBrief: input.memeBrief ?? null, memeStyle: input.memeStyle };
  await prisma.teacherMarketingProfile.upsert({
    where: { teacherId },
    create: { teacherId, ...data },
    update: data,
  });
}

export async function saveMarketingProfile(
  teacherId: string,
  input: MarketingProfileInput,
): Promise<void> {
  const data = {
    audiences: input.audiences,
    learnerLocations: input.learnerLocations,
    levels: input.levels,
    differentiator: input.differentiator ?? null,
    weeklyMinutes: input.weeklyMinutes,
    goalNewStudentsPerMonth: input.goalNewStudentsPerMonth,
  };
  await prisma.teacherMarketingProfile.upsert({
    where: { teacherId },
    create: { teacherId, ...data },
    update: data,
  });
}

// ── Inferred context ───────────────────────────────────────────────────────

export type TeacherPackageFact = {
  name: string;
  classes: number;
  priceMinorUnits: number;
  currency: string;
};

export type TeacherContext = {
  teacherId: string;
  teacherName: string;
  bookingSlug: string;
  /** The language she teaches, as an English display name for prompts. */
  subject: string;
  /** The language she teaches IN. */
  teachingLanguage: string;
  locale: string;
  country: string;
  headline: string | null;
  bio: string | null;
  /** Verbatim published testimonials. Quoting is allowed; inventing is not. */
  testimonials: { author: string; note: string | null; body: string }[];
  packages: TeacherPackageFact[];
  /** Weekday names (in English) she currently has availability on. */
  availableWeekdays: string[];
  activeStudentCount: number;
  profile: MarketingProfileView;
  capabilities: ContentCapabilities;
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * Assemble everything generation and planning are allowed to rely on, from
 * data the teacher already maintains. One query per concern, all in parallel —
 * this runs on every plan generation and on the Get Students page.
 */
export async function buildTeacherContext(
  teacherId: string,
  db: PrismaClient = prisma,
): Promise<TeacherContext | null> {
  const teacher = await db.teacher.findUnique({
    where: { id: teacherId },
    select: {
      id: true,
      name: true,
      bookingSlug: true,
      headline: true,
      bio: true,
      photoPath: true,
      locale: true,
      country: true,
      targetLanguage: true,
      teachingLanguage: true,
    },
  });
  if (!teacher) return null;

  const [profile, testimonials, templates, rules, studentCount] = await Promise.all([
    getMarketingProfile(teacherId, db),
    db.testimonial.findMany({
      where: { teacherId, published: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: 5,
      select: { authorName: true, authorNote: true, body: true },
    }),
    db.packageTemplate.findMany({
      where: { teacherId, archived: false },
      orderBy: { priceMinorUnits: "asc" },
      take: 5,
      select: { name: true, classCount: true, priceMinorUnits: true, currency: true },
    }),
    db.availabilityRule.findMany({
      where: { teacherId },
      select: { weekday: true },
      distinct: ["weekday"],
      orderBy: { weekday: "asc" },
    }),
    db.teacherStudent.count({ where: { teacherId, archivedAt: null } }),
  ]);

  const capabilities: ContentCapabilities = {
    hasTestimonial: testimonials.length > 0,
    hasPackage: templates.length > 0,
    hasStudents: studentCount > 0,
    hasAvailability: rules.length > 0,
    hasPhoto: Boolean(teacher.photoPath),
  };

  return {
    teacherId: teacher.id,
    teacherName: teacher.name,
    bookingSlug: teacher.bookingSlug,
    // Language-first product (D-72): what she teaches IS a language.
    subject: languageName(teacher.targetLanguage ?? "es"),
    teachingLanguage: languageName(teacher.teachingLanguage),
    locale: teacher.locale,
    country: teacher.country,
    headline: teacher.headline,
    bio: teacher.bio,
    testimonials: testimonials.map((t) => ({
      author: t.authorName,
      note: t.authorNote,
      body: t.body,
    })),
    packages: templates.map((t) => ({
      name: t.name,
      classes: t.classCount,
      priceMinorUnits: t.priceMinorUnits,
      currency: t.currency,
    })),
    availableWeekdays: rules.map((r) => WEEKDAY_NAMES[r.weekday] ?? "").filter(Boolean),
    activeStudentCount: studentCount,
    profile,
    capabilities,
  };
}
