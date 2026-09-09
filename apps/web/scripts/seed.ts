// Seed script for local / preview.
//
// Two layers, by design (see docs/deployment/RELEASE_AND_STAGING.md):
//
//   1. The DETERMINISTIC CORE — always seeded. Alicia Moreno (the E2E-critical
//      teacher the promote-to-production gate signs in as), her four students,
//      and a small cast of "hero" teachers that cover the whole subscription
//      matrix (Free at-cap, Pro monthly/annual, Founding, trial, past-due,
//      canceled) and both payment rails (Stripe-ready + Wise-only). This is
//      what makes preview useful for testing the monetization + checkout paths
//      before promoting. The core is small + fast so the CI E2E seed stays lean.
//
//   2. OPTIONAL BULK VOLUME — gated behind `SEED_BULK_TEACHERS` (default 0, so
//      CI is untouched). On preview, run e.g. `SEED_BULK_TEACHERS=40 pnpm seed`
//      to fill out admin lists / pagination / dashboards with realistic volume.
//      Bulk rows use the non-routable `@spiralclass-preview.invalid` domain so
//      a stray reminder cron can never email a real inbox. The loginable hero
//      accounts use real `@spiralclass.com` addresses (a catch-all you own) so
//      the genuine magic-link sign-in path is testable end to end.
//
// Idempotent: every seed teacher (Alicia + heroes + any bulk, including orphans
// from a larger previous run) is deleted before re-insert; cascades clear
// templates / packages / bookings / subscriptions / invoices. Students are
// cleared by email. Re-running is always a clean slate.
//
// Runs with the app's own database credential. ⚠️ There is no row-level
// security to bypass — tenant isolation is application-level `teacherId`
// scoping everywhere (docs/architecture/data-model.md), so this script writes
// with exactly the reach every other server-side query has. What actually stops
// it touching production is the `PROD_DB_HOSTS` guard below, and nothing else.
//
// Config comes from the committed non-secret tier, not from a per-developer
// file: `pnpm seed` loads `config/env/local.runtime.env` and `pnpm seed:preview`
// streams preview's from Infisical. There is no `.env.local` to create, and
// this header claimed there was until 2026-09-06.
//
// Usage:
//   pnpm --filter spiralclass-web seed         # core, local DB
//   pnpm seed:preview                          # core, preview DB
//   SEED_BULK_TEACHERS=40 pnpm seed:preview    # core + 40 synthetic teachers

import { randomUUID } from "crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { addDays, startOfDay } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { PrismaClient, Prisma, type PackageTemplate } from "@prisma/client";
import { pgAdapter } from "@/lib/db-pool";
import { nextWeekdayMatching } from "@/lib/seed/snap-weekday";
import { ensureTeacherLevels } from "@/lib/levels";
import {
  ensureIntegrationsSeeded,
  refreshDefaultIntegrations,
} from "@/lib/economics/seed-registry";
import { getStorageProvider, PUBLIC_VERSIONED_ASSET_CACHE_CONTROL } from "@/lib/storage/provider";
import { MATERIALS_BUCKET } from "@/lib/storage/signed-urls";
import {
  TEACHER_PHOTO_BUCKET,
  ensureTeacherPhotoBucket,
  teacherPhotoStorageKey,
} from "@/lib/storage/teacher-photo";
import {
  TEACHER_VIDEO_BUCKET,
  ensureTeacherVideoBucket,
  teacherVideoStorageKey,
} from "@/lib/storage/teacher-video";
import { seedPlaceholderPhotoPng } from "@/lib/seed/placeholder-photo";
import { SEED_VIDEO_CONTENT_TYPE, seedPlaceholderVideoMp4 } from "@/lib/seed/placeholder-video";
import {
  PLAN_PRICE_MINOR_UNITS,
  TRIAL_DAYS,
  PAST_DUE_GRACE_DAYS,
} from "@/lib/subscriptions/config";
import { seedFixtures } from "./seed-fixtures";

// --- Alicia Moreno: the E2E-critical teacher. DO NOT change her email, slug,
// Stripe-ready flags, package-template names, or availability — the promote
// gate (tests/e2e/happy-path.spec.ts + cancel-reschedule.spec.ts) signs in as
// her and asserts against exactly these values.
const SEED_EMAIL = "alicia.moreno@spiralclass.test";

// Two accounts this script bootstraps belong to real people: the operator, as
// superadmin, and a tester, who needs an inbox that can actually receive a
// sign-in code. Neither address is written here — this repository is public,
// and a real person's inbox is not a fixture to publish (docs/security.md).
//
// Set both in the environment where they matter (preview) and leave them unset
// everywhere else. The fallbacks are synthetic and the seed behaves identically
// with them: `.invalid` is reserved by RFC 2606 and can never route mail, so an
// unset variable cannot quietly bootstrap superadmin onto an address someone
// else could register.
const OPERATOR_EMAIL = process.env.SEED_OPERATOR_EMAIL ?? "operator@spiralclass-preview.invalid";
const PILOT_TEACHER_EMAIL =
  process.env.SEED_PILOT_TEACHER_EMAIL ?? "pilot-teacher@spiralclass-preview.invalid";
const SEED_TZ = "America/Mexico_City";
// Alicia Moreno's seed availability is Mon–Fri; reused for every seeded teacher so
// snapped bookings always land on a bookable weekday.
const SEED_WEEKDAYS = [1, 2, 3, 4, 5];
// Every seeded teacher gets her OWN photo object, generated and uploaded by
// this script — see seedTeacherPhoto() below and lib/seed/placeholder-photo.ts
// for why the shared "Alicia Moreno's real object migrated from prod" key had to
// go (short version: preview and production are different buckets, nothing
// copied the object across, and a photo_path that 404s renders a broken image
// because the null-check fallback never fires).
const seedPhotoPath = (teacherId: string) => teacherPhotoStorageKey(teacherId);
// The intro video is generated and uploaded the same way the photo is — under
// the teacher's own key, in whichever bucket the seed ran against. It used to
// be the production teacher's real 6.3 MB object, which preview's separate
// bucket never had; see lib/seed/placeholder-video.ts.
//
// Only ONE hero gets a video. The card is the most expensive thing on the
// booking page and there is no reason for fifteen seeded teachers to have one.
// Degrades to no video section at all when
// NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL is unset (introVideoStorageConfigured),
// so a local run without R2 renders nothing rather than a broken element.
const seedIntroVideoPath = (teacherId: string) => teacherVideoStorageKey(teacherId);

// A REAL Stripe test-mode connected account for the seeded teachers, when one
// is available.
//
// Every seeded teacher used to get a fabricated `acct_seed_<key>`, which no
// Stripe account has ever matched. In the E2E suite that is harmless — the
// Stripe client is stubbed (lib/stripe/stub.ts) and never calls the API. On
// PREVIEW it is not: the real client sends that id as the `Stripe-Account`
// header and Stripe answers
//
//   403 account_invalid — "The provided key 'sk_test_…' does not have access
//   to account 'acct_seed_paulapagos' (or that account does not exist)"
//
// so the card rail was not merely untested on preview, it was untestable: the
// teacher looked card-capable on the booking page and 403'd at checkout. The
// two manual rails could be exercised end to end; the one that takes cards
// could not.
//
// Set SEED_STRIPE_ACCOUNT_ID (Infisical, preview env) to a real test-mode
// connected account and the Stripe-ready seed teachers use it, making the card
// rail genuinely exercisable. Leave it unset and they fall back to the stub,
// which is what CI wants — the stub id is also what the cleanup uses to
// recognise its own rows, so it has to stay a stable `acct_seed_*` shape.
const SEED_STRIPE_ACCOUNT_ID = process.env.SEED_STRIPE_ACCOUNT_ID?.trim() || null;

// The connected-account id to write for a Stripe-ready seed teacher. Only ONE
// teacher can hold a given account id — `teachers.stripe_account_id` is unique
// — so the real id goes to the teacher a human is most likely to test with and
// everyone else keeps their stub.
function seedStripeAccountId(key: string, preferReal: boolean): string {
  if (preferReal && SEED_STRIPE_ACCOUNT_ID) return SEED_STRIPE_ACCOUNT_ID;
  return `acct_seed_${key}`;
}

const SEED_STUDENT_EMAILS = [
  "maria@alumno.test",
  "carlos@alumno.test",
  "sofia@alumno.test",
  "marcela@alumno.test",
];

// The manual-UAT first-time buyer (/admin/uat's §B, runbook-steps.ts). Not
// seeded — created when §B runs the real purchase — but cleaned up on every reseed so
// the next UAT run starts from a genuine first purchase.
const UAT_BUYER_EMAIL = "alumno.uat@spiralclass.com";

// Domains. Hero accounts are loginable → routable @spiralclass.com. Bulk volume
// is fire-and-forget → RFC-6761 `.invalid` TLD, guaranteed never deliverable.
const HERO_DOMAIN = "spiralclass.com";
const BULK_DOMAIN = "spiralclass-preview.invalid";

// Small deterministic PRNG (mulberry32) so reseeds produce identical data and
// bulk variety is stable across runs. Math.random would make every reseed
// churn the dataset.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Seeding dependencies, abstracted so user-provisioning and storage
// upload — the two things every caller needs but might want to implement
// differently — aren't hardwired into seedAll() itself. main() below is the
// only real implementation today (direct UUID + `user`-table insert, R2
// storage); everything else in seedAll() is plain Prisma.
export interface SeedDeps {
  // Returns the `user` table id for this teacher (reusing an existing row by
  // email so teacher.id stays stable across reseeds).
  provisionTeacherAuthUser(email: string, name: string): Promise<string>;
  // Best-effort: ensure a `user` row exists for a (routable) hero student so
  // the normal email-OTP sign-in path works for them too. No-op-tolerant.
  ensureStudentAuthUser(email: string): Promise<void>;
  // Best-effort fixture upload; tolerates a missing bucket.
  uploadMaterial(storagePath: string, pdf: Buffer): Promise<{ ok: boolean; error?: string }>;
  // Best-effort: put this teacher's generated placeholder photo in the public
  // teacher-photos bucket, keyed by her id. Best-effort because an env with no
  // R2 credentials (a bare local run) must still seed — there the public URL
  // resolves to null anyway and the avatar falls through to the initials
  // monogram, so a failed upload costs nothing. On an env that HAS a public
  // bucket URL, this is the difference between an avatar and a broken image.
  uploadTeacherPhoto(teacherId: string, png: Buffer): Promise<{ ok: boolean; error?: string }>;
  // Best-effort, exactly as above, for the one hero who has an intro video.
  uploadTeacherVideo(teacherId: string, mp4: Buffer): Promise<{ ok: boolean; error?: string }>;
}

export interface SeedOptions {
  bulkTeachers: number;
  studentsPerBulkTeacher: number;
}

// Generate + upload one seeded teacher's monogram, then hand back the
// photo_path to store on her row. The path is returned unconditionally, even
// when the upload failed: `hasPhoto` is one of isPubliclyListed()'s signals
// (D-104) and several seeded teachers are meant to be listed, so the column
// must not depend on whether this env happens to have R2 credentials. A failed
// upload is announced rather than swallowed — on preview it is the whole bug
// this function exists to fix.
export async function seedTeacherPhoto(
  deps: SeedDeps,
  teacherId: string,
  name: string,
  email: string,
): Promise<string> {
  const png = await seedPlaceholderPhotoPng(name, email);
  const res = await deps.uploadTeacherPhoto(teacherId, png);
  if (!res.ok) console.warn(`  ! photo upload failed for ${email}: ${res.error ?? "unknown"}`);
  return seedPhotoPath(teacherId);
}

// The same for the one hero with an intro video — but returning null when the
// upload failed, where the photo returns its path regardless. The asymmetry is
// deliberate: a null photo_path still renders (the initials monogram) and
// feeds isPubliclyListed()'s hasPhoto signal, whereas IntroVideoCard renders
// whenever intro_video_path is non-null and has no fallback at all. So a video
// pointer that outlives its object IS the bug; better no video section.
export async function seedTeacherIntroVideo(
  deps: SeedDeps,
  teacherId: string,
  email: string,
): Promise<string | null> {
  const res = await deps.uploadTeacherVideo(teacherId, seedPlaceholderVideoMp4());
  if (!res.ok) {
    console.warn(`  ! intro video upload failed for ${email}: ${res.error ?? "unknown"}`);
    return null;
  }
  return seedIntroVideoPath(teacherId);
}

type TimeFns = {
  inMx: (d: Date) => Date;
  slot: (offsetDays: number, hour: number, tz?: string) => Date;
};

function makeTimeFns(now: Date): TimeFns {
  const inMx = (d: Date) => fromZonedTime(d, SEED_TZ);
  const slot = (offsetDays: number, hour: number, tz: string = SEED_TZ) => {
    const snapped = nextWeekdayMatching(addDays(now, offsetDays), SEED_WEEKDAYS);
    const local = new Date(startOfDay(snapped).getTime() + hour * 3600_000);
    return fromZonedTime(local, tz);
  };
  return { inMx, slot };
}

const FIFTY_MIN = 50 * 60_000;

// Standard two-block weekday availability (matches Alicia Moreno's). Rules carry
// the zone their wall clock was written in (D-53); every seed teacher lives in
// SEED_TZ, so stamp that.
function weekdayAvailability(timezone: string = SEED_TZ) {
  return SEED_WEEKDAYS.flatMap((weekday) => [
    { weekday, startTime: "09:00", endTime: "13:00", timezone },
    { weekday, startTime: "16:00", endTime: "19:00", timezone },
  ]);
}

// =====================================================================
// Hero teachers: the subscription + payment-rail matrix.
// =====================================================================

type SubSpec = {
  plan: "free" | "monthly" | "annual" | "founding";
  status: "trialing" | "active" | "past_due" | "canceled" | "free";
  comped?: boolean;
  // Days from now; negative = past. Drives trial/grace/cancel banners.
  trialEndsInDays?: number;
  currentPeriodEndInDays?: number;
  canceledDaysAgo?: number;
};

type StudentSpec = {
  name: string;
  phone: string;
  classesTotal: number;
  classesUsed: number;
  status: "active" | "expired" | "paused";
  purchasedDaysAgo: number;
  expiresInDays: number;
  rail: "card" | "wise";
  completedOffsets: number[];
  scheduledOffsets: number[];
  hour: number;
};

// One payout instrument to create for a hero. `wiseOnly` is the older,
// narrower way to say `[{ kind: "wise" }]` and is kept because three specs and
// a Maestro flow depend on its exact behaviour; anything richer than a single
// Wise instrument uses this instead.
type InstrumentSpec =
  // One member since D-145 removed `bank_account`. Kept as a union so adding
  // a kind back is a member rather than a reshape of every hero.
  { kind: "wise" };

type TemplateSpec = {
  name: string;
  classCount: number;
  priceMinorUnits: number;
  expirationMonths: number;
  // Pay-at-reservation (D-111): checkout refuses money until a time is chosen,
  // and the slot picker moves above the pay button. Distinct from classCount 1
  // — see class-offering.ts for why those are two different questions.
  singleClass?: boolean;
  // The non-card price. Set BELOW priceMinorUnits to exercise the transfer
  // discount and the "you save" line, which no seed teacher had.
  transferPriceMinorUnits?: number;
};

type HeroSpec = {
  key: string; // used for student email prefixes
  name: string;
  email: string;
  slug: string;
  headline: string;
  // Payment rail config.
  stripeReady: boolean;
  wiseOnly?: boolean;
  // Richer rail config, for the heroes that exist to cover the manual bank
  // rail and the multi-rail chooser. Mutually exclusive with `wiseOnly` in
  // practice; the spec test asserts a hero does not set both.
  instruments?: InstrumentSpec[];
  // What SHE sells in. Defaults to the column default (MXN). A non-2-decimal
  // value here is the point for one hero: minor-unit arithmetic is the bug
  // class CLAUDE.md calls out, and nothing in the seed exercised it.
  pricingCurrency?: string;
  // The teacher's own country — decides which bank schemes and Connect
  // behaviour apply. Defaults to the column default.
  country?: string;
  // Which language HER BUYERS read (D-73's fourth language field). Nothing in
  // the seed varied it, so the public funnel's locale resolution was only ever
  // exercised at its default.
  bookingPageLocale?: string;
  // Social proof on the landing page and, since D-144, in the checkout itself.
  testimonials?: { authorName: string; authorNote?: string; body: string }[];
  // Give this hero a placeholder intro video, so the video card is reachable in
  // a seeded environment at all. Opt-in per hero — see seedTeacherIntroVideo.
  introVideo?: true;
  // Single template all this hero's students buy.
  template: TemplateSpec;
  sub: SubSpec;
  // Extra over-cap data to exercise Free-tier grandfathering (read-only).
  extraTemplates?: TemplateSpec[];
  students: StudentSpec[];
};

export function heroSpecs(): HeroSpec[] {
  return [
    {
      key: "beatriz",
      name: "Beatriz Soto",
      email: `profe.pro.monthly@${HERO_DOMAIN}`,
      slug: "beatriz-soto",
      headline: "Clases de inglés conversacional",
      stripeReady: true,
      template: {
        name: "8 clases / 1 mes",
        classCount: 8,
        priceMinorUnits: 240_000,
        expirationMonths: 1,
      },
      sub: { plan: "monthly", status: "active", currentPeriodEndInDays: 18 },
      students: [
        {
          name: "Lucía Fuentes",
          phone: "+5215555100101",
          classesTotal: 8,
          classesUsed: 3,
          status: "active",
          purchasedDaysAgo: 12,
          expiresInDays: 18,
          rail: "card",
          completedOffsets: [-9, -2],
          scheduledOffsets: [3, 10],
          hour: 9,
        },
        {
          name: "Pablo Méndez",
          phone: "+5215555100102",
          classesTotal: 8,
          classesUsed: 1,
          status: "active",
          purchasedDaysAgo: 5,
          expiresInDays: 25,
          rail: "card",
          completedOffsets: [-3],
          scheduledOffsets: [4, 11],
          hour: 11,
        },
        {
          name: "Renata Gil",
          phone: "+5215555100103",
          classesTotal: 8,
          classesUsed: 8,
          status: "expired",
          purchasedDaysAgo: 50,
          expiresInDays: -5,
          rail: "card",
          completedOffsets: [-30, -20],
          scheduledOffsets: [],
          hour: 12,
        },
      ],
    },
    {
      key: "diego",
      name: "Diego Márquez",
      email: `profe.pro.annual@${HERO_DOMAIN}`,
      slug: "diego-marquez",
      headline: "Guitarra para todos los niveles",
      stripeReady: true,
      template: {
        name: "10 clases / 3 meses",
        classCount: 10,
        priceMinorUnits: 280_000,
        expirationMonths: 3,
      },
      sub: { plan: "annual", status: "active", currentPeriodEndInDays: 200 },
      students: [
        {
          name: "Andrés Lara",
          phone: "+5215555100201",
          classesTotal: 10,
          classesUsed: 4,
          status: "active",
          purchasedDaysAgo: 20,
          expiresInDays: 70,
          rail: "card",
          completedOffsets: [-14, -7],
          scheduledOffsets: [2, 9],
          hour: 16,
        },
        {
          name: "Daniela Cano",
          phone: "+5215555100202",
          classesTotal: 10,
          classesUsed: 2,
          status: "active",
          purchasedDaysAgo: 8,
          expiresInDays: 82,
          rail: "card",
          completedOffsets: [-5],
          scheduledOffsets: [5, 12],
          hour: 17,
        },
        {
          name: "Tomás Vega",
          phone: "+5215555100203",
          classesTotal: 4,
          classesUsed: 0,
          status: "active",
          purchasedDaysAgo: 1,
          expiresInDays: 29,
          rail: "card",
          completedOffsets: [],
          scheduledOffsets: [6],
          hour: 18,
        },
      ],
    },
    {
      key: "elena",
      name: "Elena Vargas",
      email: `profe.founding@${HERO_DOMAIN}`,
      slug: "elena-vargas",
      headline: "Matemáticas sin miedo",
      stripeReady: true,
      template: {
        name: "4 clases / 1 mes",
        classCount: 4,
        priceMinorUnits: 130_000,
        expirationMonths: 1,
      },
      sub: { plan: "founding", status: "active", currentPeriodEndInDays: 14 },
      students: [
        {
          name: "Mateo Ríos",
          phone: "+5215555100301",
          classesTotal: 4,
          classesUsed: 1,
          status: "active",
          purchasedDaysAgo: 6,
          expiresInDays: 24,
          rail: "card",
          completedOffsets: [-3],
          scheduledOffsets: [3, 8],
          hour: 10,
        },
        {
          name: "Valeria Soto",
          phone: "+5215555100302",
          classesTotal: 4,
          classesUsed: 2,
          status: "active",
          purchasedDaysAgo: 10,
          expiresInDays: 20,
          rail: "card",
          completedOffsets: [-7, -2],
          scheduledOffsets: [5],
          hour: 12,
        },
      ],
    },
    {
      key: "fernando",
      name: "Fernando Cruz",
      email: `profe.trial@${HERO_DOMAIN}`,
      slug: "fernando-cruz",
      headline: "Programación para principiantes",
      // New teacher mid-trial — hasn't connected Stripe yet (warning state).
      stripeReady: false,
      template: {
        name: "4 clases / 1 mes",
        classCount: 4,
        priceMinorUnits: 130_000,
        expirationMonths: 1,
      },
      // trial ending within TRIAL_ENDING_NOTICE_DAYS → exercises the nudge.
      sub: { plan: "free", status: "trialing", trialEndsInDays: 2 },
      students: [
        {
          name: "Camila Peña",
          phone: "+5215555100401",
          classesTotal: 4,
          classesUsed: 0,
          status: "active",
          purchasedDaysAgo: 1,
          expiresInDays: 29,
          rail: "card",
          completedOffsets: [],
          scheduledOffsets: [2],
          hour: 11,
        },
      ],
    },
    {
      key: "gabriela",
      name: "Gabriela Reyes",
      email: `profe.free@${HERO_DOMAIN}`,
      slug: "gabriela-reyes",
      headline: "Clases de canto",
      // Getting paid stays free on every tier → Stripe stays connected.
      stripeReady: true,
      template: {
        name: "8 clases / 1 mes",
        classCount: 8,
        priceMinorUnits: 240_000,
        expirationMonths: 1,
      },
      sub: { plan: "free", status: "free" },
      // OVER the Free caps (FREE_MAX_ACTIVE_STUDENTS=3, FREE_MAX_PACKAGE_TEMPLATES=1):
      // 4 students + a 2nd template, all grandfathered read-only on downgrade.
      extraTemplates: [
        {
          name: "20 clases / 5 meses",
          classCount: 20,
          priceMinorUnits: 550_000,
          expirationMonths: 5,
        },
      ],
      students: [
        {
          name: "Jimena Ortiz",
          phone: "+5215555100501",
          classesTotal: 8,
          classesUsed: 2,
          status: "active",
          purchasedDaysAgo: 15,
          expiresInDays: 15,
          rail: "card",
          completedOffsets: [-10, -3],
          scheduledOffsets: [4],
          hour: 9,
        },
        {
          name: "Bruno Salas",
          phone: "+5215555100502",
          classesTotal: 8,
          classesUsed: 1,
          status: "active",
          purchasedDaysAgo: 9,
          expiresInDays: 21,
          rail: "card",
          completedOffsets: [-4],
          scheduledOffsets: [6],
          hour: 10,
        },
        {
          name: "Ximena Luna",
          phone: "+5215555100503",
          classesTotal: 8,
          classesUsed: 0,
          status: "active",
          purchasedDaysAgo: 3,
          expiresInDays: 27,
          rail: "card",
          completedOffsets: [],
          scheduledOffsets: [7],
          hour: 12,
        },
        {
          name: "Iván Cordero",
          phone: "+5215555100504",
          classesTotal: 8,
          classesUsed: 3,
          status: "active",
          purchasedDaysAgo: 20,
          expiresInDays: 10,
          rail: "card",
          completedOffsets: [-12, -6, -2],
          scheduledOffsets: [8],
          hour: 16,
        },
      ],
    },
    {
      key: "hugo",
      name: "Hugo Ramírez",
      email: `profe.pastdue@${HERO_DOMAIN}`,
      slug: "hugo-ramirez",
      headline: "Francés desde cero",
      stripeReady: true,
      template: {
        name: "8 clases / 1 mes",
        classCount: 8,
        priceMinorUnits: 240_000,
        expirationMonths: 1,
      },
      // Charge failed; still in the 7-day grace window (period ended 2 days ago).
      sub: { plan: "monthly", status: "past_due", currentPeriodEndInDays: -2 },
      students: [
        {
          name: "Núria Campos",
          phone: "+5215555100601",
          classesTotal: 8,
          classesUsed: 5,
          status: "active",
          purchasedDaysAgo: 25,
          expiresInDays: 5,
          rail: "card",
          completedOffsets: [-18, -11, -4],
          scheduledOffsets: [3, 9],
          hour: 17,
        },
        {
          name: "Óscar Belmonte",
          phone: "+5215555100602",
          classesTotal: 4,
          classesUsed: 1,
          status: "active",
          purchasedDaysAgo: 7,
          expiresInDays: 23,
          rail: "card",
          completedOffsets: [-3],
          scheduledOffsets: [5],
          hour: 18,
        },
      ],
    },
    {
      key: "ines",
      name: "Inés Navarro",
      email: `profe.wise@${HERO_DOMAIN}`,
      slug: "ines-navarro",
      headline: "Yoga y respiración",
      // Wise-only: no Stripe account at all; the public page offers only Wise.
      stripeReady: false,
      wiseOnly: true,
      template: {
        name: "10 clases / 3 meses",
        classCount: 10,
        priceMinorUnits: 280_000,
        expirationMonths: 3,
      },
      sub: { plan: "monthly", status: "active", currentPeriodEndInDays: 22 },
      students: [
        {
          name: "Alba Serrano",
          phone: "+5215555100701",
          classesTotal: 10,
          classesUsed: 3,
          status: "active",
          purchasedDaysAgo: 14,
          expiresInDays: 76,
          rail: "wise",
          completedOffsets: [-9, -2],
          scheduledOffsets: [4, 11],
          hour: 10,
        },
        {
          name: "Leo Pardo",
          phone: "+5215555100702",
          classesTotal: 10,
          classesUsed: 1,
          status: "active",
          purchasedDaysAgo: 4,
          expiresInDays: 86,
          rail: "wise",
          completedOffsets: [-2],
          scheduledOffsets: [6],
          hour: 12,
        },
      ],
    },
    {
      key: "jorge",
      name: "Jorge Medina",
      email: `profe.canceled@${HERO_DOMAIN}`,
      slug: "jorge-medina",
      headline: "Historia del arte",
      stripeReady: true,
      template: {
        name: "4 clases / 1 mes",
        classCount: 4,
        priceMinorUnits: 130_000,
        expirationMonths: 1,
      },
      // Subscription canceled; data grandfathered read-only.
      sub: {
        plan: "monthly",
        status: "canceled",
        canceledDaysAgo: 10,
        currentPeriodEndInDays: -10,
      },
      students: [
        {
          name: "Rocío Aguilar",
          phone: "+5215555100801",
          classesTotal: 4,
          classesUsed: 4,
          status: "expired",
          purchasedDaysAgo: 40,
          expiresInDays: -9,
          rail: "card",
          completedOffsets: [-30, -22, -16, -9],
          scheduledOffsets: [],
          hour: 9,
        },
        {
          name: "Saúl Ibáñez",
          phone: "+5215555100802",
          classesTotal: 8,
          classesUsed: 2,
          status: "active",
          purchasedDaysAgo: 12,
          expiresInDays: 18,
          rail: "card",
          completedOffsets: [-8, -3],
          scheduledOffsets: [4],
          hour: 11,
        },
      ],
    },
    {
      // Bare Wise-only fixture for the existing Wise E2E journeys
      // (tests/e2e/mobile-wise-checkout.api.spec.ts + the Wise leg of
      // cancel-reschedule.spec.ts). DO NOT change her email/slug/handle: those
      // tests hardcode `wendy.wise@spiralclass.test` / `wendy-wise`,
      // resolve her cheapest template at runtime, and build the Wise pay link
      // from the `wendywise` handle. `key` is "wendywise" so wiseHandle resolves
      // to it. No seeded students — those journeys create their own buyer.
      key: "wendywise",
      name: "Wendy Wise",
      email: "wendy.wise@spiralclass.test",
      slug: "wendy-wise",
      headline: "Clases de alemán",
      stripeReady: false,
      wiseOnly: true,
      template: {
        name: "4 clases / 1 mes",
        classCount: 4,
        priceMinorUnits: 130_000,
        expirationMonths: 1,
      },
      extraTemplates: [
        { name: "8 clases / 1 mes", classCount: 8, priceMinorUnits: 240_000, expirationMonths: 1 },
      ],
      sub: { plan: "free", status: "trialing", trialEndsInDays: 20 },
      students: [],
    },
    {
      // Bare NO-RAIL fixture, owned exclusively by tests/e2e/payout-rail.spec.ts
      // (UAT §A+ — connecting a payout rail). DO NOT change her email/slug, and
      // do NOT assert anything about her from another spec.
      //
      // She exists because that journey MUTATES a teacher's rail: it turns Wise
      // on and checks the public booking page flips from the no-rail notice to
      // a Wise CTA. Run against a shared hero, that write would leak across
      // files — subscription-and-rails.spec.ts asserts exactly these two states
      // on fernando-cruz and ines-navarro, and would start passing or failing
      // depending on file order. The spec restores her rail in afterAll, but
      // per CLAUDE.md's shared-fixture rule an in-spec cleanup is not on its
      // own sufficient (a crash between the write and the cleanup leaves it
      // dirty); a dedicated fixture means the blast radius of that is one spec
      // instead of two, and re-seeding is the backstop reset.
      //
      // stripeReady: false + no wiseOnly — she starts with NO rail at all,
      // which is the precondition the journey needs.
      key: "norail",
      name: "Nora Sinriel",
      email: "nora.norail@spiralclass.test",
      slug: "nora-norail",
      headline: "Clases de italiano",
      stripeReady: false,
      template: {
        name: "4 clases / 1 mes",
        classCount: 4,
        priceMinorUnits: 130_000,
        expirationMonths: 1,
      },
      sub: { plan: "free", status: "trialing", trialEndsInDays: 20 },
      students: [],
    },
    {
      // The UAT account: a real inbox that can receive a sign-in code, rather
      // than a synthetic @spiralclass.test address that cannot. No seeded
      // students — whoever tests drives their own purchases live.
      //
      // The address is NOT in this file. It comes from PILOT_TEACHER_EMAIL,
      // which is set on preview only; a public checkout seeds the synthetic
      // fallback instead and behaves identically. This repository is public,
      // and a real person's inbox is not a fixture to publish — see
      // docs/security.md. Same reasoning as the admin bootstrap at the foot of
      // main().
      key: "aliciamorenoespanol",
      name: "Alicia Moreno",
      email: PILOT_TEACHER_EMAIL,
      slug: "alicia-moreno-espanol",
      headline: "Clases de español",
      stripeReady: true,
      template: {
        name: "8 clases / 1 mes",
        classCount: 8,
        priceMinorUnits: 240_000,
        expirationMonths: 1,
      },
      sub: { plan: "monthly", status: "active", currentPeriodEndInDays: 30 },
      students: [],
    },
    {
      // --- EVERY RAIL AT ONCE, plus the booking-page surface. ---------------
      // The multi-rail teacher: card AND a transfer, which is what renders the
      // payment-method chooser at all — since D-144 a disclosure ("Prefer to
      // pay by bank transfer?") rather than the first control on the page, so
      // without a hero like this neither the disclosure nor the picker inside
      // it is reachable in any seeded environment.
      //
      // She had a third rail until D-145: a `bank_account` SPEI instrument
      // alongside Wise. That kind is gone, and so is the bank-only hero who
      // existed to cover the `bank_account` arm of HAS_PAYOUT_RAIL_WHERE —
      // there is no such arm any more.
      //
      // She also carries the three booking-page features nothing seeded:
      //   * a transfer DISCOUNT, so the "you save" line on the disclosure has
      //     a non-zero saving to show;
      //   * a singleClass template, so pay-at-reservation is reachable — the
      //     slot picker moves ABOVE the pay button and checkout refuses money
      //     until a time is chosen (D-111, and the ordering rule from D-144);
      //   * testimonials, which the landing page has always rendered and the
      //     checkout has rendered since D-144, and which no seed teacher had.
      key: "paulapagos",
      name: "Paula Pagos",
      email: "paula.pagos@spiralclass.test",
      slug: "paula-pagos",
      headline: "Clases de portugués",
      stripeReady: true,
      instruments: [{ kind: "wise" }],
      // She sells to English speakers, like the live Mexican teacher — the
      // exact case D-73 exists for, and the one that makes the approximate-USD
      // price render. Every other hero leaves this at its default.
      bookingPageLocale: "en",
      introVideo: true,
      testimonials: [
        {
          authorName: "Rita Alves",
          authorNote: "B1 · 8 months",
          body: "I went from freezing up on calls to running a whole meeting in Portuguese. Paula never once let me switch back to English.",
        },
        {
          authorName: "Tom Whitfield",
          authorNote: "A2 · 4 months",
          body: "Booked one class to try it. Booked twenty more the same week.",
        },
      ],
      template: {
        name: "Clase individual",
        classCount: 1,
        // Pay-at-reservation. Distinct from classCount 1 — see
        // class-offering.ts; this is the flag that makes checkout demand a time.
        singleClass: true,
        priceMinorUnits: 38_000,
        // 5% off for not paying the card fee, so the saving is visible and
        // large enough to be worth naming (the UI hides anything under ~3%).
        transferPriceMinorUnits: 36_100,
        expirationMonths: 1,
      },
      extraTemplates: [
        {
          name: "8 clases / 3 meses",
          classCount: 8,
          priceMinorUnits: 250_000,
          transferPriceMinorUnits: 237_500,
          expirationMonths: 3,
        },
      ],
      sub: { plan: "monthly", status: "active", currentPeriodEndInDays: 30 },
      students: [],
    },
    {
      // --- A 0-DECIMAL CURRENCY. --------------------------------------------
      // Every seeded price was MXN, so every seeded price had two decimals, so
      // the currency-aware minor-unit arithmetic that CLAUDE.md calls out as a
      // standing hazard ("omitting it multiplies a 0-decimal price by 100") was
      // never exercised against real rows anywhere.
      //
      // JPY has exponent 0, so `priceMinorUnits` here IS yen — 5_000 is ¥5,000,
      // not ¥50. Japan is in SUPPORTED_CONNECT_COUNTRIES (D-143), so a
      // Stripe-ready Japanese teacher pricing in yen is a shape the product
      // genuinely supports rather than a synthetic edge case. If a formatter or
      // a conversion ever divides this by 100, her booking page says ¥50 and
      // the error is visible on sight.
      key: "yuki",
      name: "Yuki Tanaka",
      email: "yuki.tanaka@spiralclass.test",
      slug: "yuki-tanaka",
      headline: "Japanese conversation classes",
      stripeReady: true,
      pricingCurrency: "JPY",
      country: "JP",
      template: {
        name: "4 classes / 1 month",
        classCount: 4,
        priceMinorUnits: 18_000,
        expirationMonths: 1,
      },
      extraTemplates: [
        {
          name: "Single class",
          classCount: 1,
          singleClass: true,
          priceMinorUnits: 5_000,
          expirationMonths: 1,
        },
      ],
      sub: { plan: "free", status: "free" },
      students: [],
    },
  ];
}

// Minor units a subscription is locked to (null for free / trial-on-free).
export function lockedPriceFor(sub: SubSpec): number | null {
  if (sub.plan === "free") return null;
  return PLAN_PRICE_MINOR_UNITS[sub.plan];
}

async function seedSubscription(
  prisma: PrismaClient,
  teacherId: string,
  sub: SubSpec,
  now: Date,
  idx: number,
) {
  const trialEndsAt = sub.trialEndsInDays !== undefined ? addDays(now, sub.trialEndsInDays) : null;
  const currentPeriodEnd =
    sub.currentPeriodEndInDays !== undefined ? addDays(now, sub.currentPeriodEndInDays) : null;
  const canceledAt = sub.canceledDaysAgo !== undefined ? addDays(now, -sub.canceledDaysAgo) : null;
  const paid = sub.status === "active" || sub.status === "past_due";

  await prisma.teacherSubscription.create({
    data: {
      teacherId,
      plan: sub.plan,
      status: sub.status,
      comped: sub.comped ?? false,
      lockedPriceMinorUnits: lockedPriceFor(sub),
      trialEndsAt,
      currentPeriodEnd,
      canceledAt,
      // Synthetic platform-billing ids (NOT Connect) so unique columns are
      // populated where a real paid subscription would carry them.
      stripeCustomerId: paid || sub.status === "canceled" ? `cus_seed_${idx}` : null,
      stripeSubscriptionId: paid || sub.status === "canceled" ? `sub_seed_${idx}` : null,
    },
  });

  // A representative invoice for billed plans, so the admin MRR / commission
  // views and the past-due/failed states have a row to render.
  if (sub.plan !== "free") {
    const amount = PLAN_PRICE_MINOR_UNITS[sub.plan];
    const fee = Math.round(amount * 0.036) + 300; // rough Stripe-ish fee
    const periodStart = addDays(now, sub.plan === "annual" ? -165 : -28);
    const periodEnd = currentPeriodEnd ?? addDays(now, 2);
    const failed = sub.status === "past_due";
    await prisma.subscriptionInvoice.create({
      data: {
        teacherId,
        periodStart,
        periodEnd,
        amountMinorUnits: amount,
        feeMinorUnits: failed ? 0 : fee,
        netMinorUnits: failed ? 0 : amount - fee,
        status: failed ? "failed" : "paid",
        provider: "stripe",
        stripeInvoiceId: `in_seed_${idx}`,
        paidAt: failed ? null : addDays(now, sub.plan === "annual" ? -165 : -28),
      },
    });
  }
}

async function seedStudentWithUsage(
  prisma: PrismaClient,
  deps: SeedDeps,
  time: TimeFns,
  args: {
    teacherId: string;
    email: string;
    routable: boolean;
    template: PackageTemplate;
    spec: StudentSpec;
    tz: string;
    // The teacher's Wise instrument, when she has one. A manual-transfer
    // payment must carry it — `payments_instrument_required_for_manual_transfer`
    // rejects the insert otherwise (D-113).
    wiseInstrumentId?: string | null;
  },
) {
  const { teacherId, email, routable, template, spec, tz } = args;
  if (routable) await deps.ensureStudentAuthUser(email);

  const now = new Date();
  const student = await prisma.student.create({
    data: {
      // Ownership marker — see the `seeded_at` note in schema.prisma.
      seededAt: new Date(),
      id: randomUUID(),
      email,
      name: spec.name,
      // English — the UAT runbook (/admin/uat) assumes an English device and
      // expects English push/email copy for these hero students.
      locale: "en",
      phoneE164: spec.phone,
      teacherStudents: { create: { teacherId } },
      // Skip the first-login onboarding gate for every bulk/hero fixture —
      // same pattern as seedBulkTeacher below. Authenticated student flows
      // assume they land straight on the app; only `seed-teacher-onboarding`
      // is meant to hit a wizard.
      onboardingCompleteAt: now,
    },
  });

  const pkg = await prisma.package.create({
    data: {
      teacherId,
      studentId: student.id,
      templateId: template.id,
      classesTotal: spec.classesTotal,
      classesUsed: spec.classesUsed,
      pricePaidMinorUnits: template.priceMinorUnits,
      purchasedAt: addDays(now, -spec.purchasedDaysAgo),
      expiresAt: addDays(now, spec.expiresInDays),
      status: spec.status,
    },
  });

  // A paid payment row on the matching rail, so the funnel + payouts views
  // have data and the Wise-only teacher's students carry Wise payments.
  await prisma.payment.create({
    data: {
      packageId: pkg.id,
      amountMinorUnits: template.priceMinorUnits,
      status: "paid",
      provider: spec.rail === "wise" ? "manual_transfer" : "stripe",
      rail: spec.rail,
      paidAt: addDays(now, -spec.purchasedDaysAgo),
      ...(spec.rail === "wise"
        ? {
            paymentReference: `AGP-${student.id.slice(0, 8).toUpperCase()}`,
            instrumentId: args.wiseInstrumentId!,
          }
        : {}),
    },
  });

  const bookings = [
    ...spec.completedOffsets.map((off) => {
      const start = time.slot(off, spec.hour, tz);
      return {
        packageId: pkg.id,
        teacherId,
        studentId: student.id,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + FIFTY_MIN),
        status: "completed" as const,
        completedAt: addDays(now, off),
      };
    }),
    ...spec.scheduledOffsets.map((off) => {
      const start = time.slot(off, spec.hour, tz);
      return {
        packageId: pkg.id,
        teacherId,
        studentId: student.id,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + FIFTY_MIN),
        status: "scheduled" as const,
      };
    }),
  ];
  if (bookings.length > 0) await prisma.booking.createMany({ data: bookings });
}

async function seedHero(
  prisma: PrismaClient,
  deps: SeedDeps,
  time: TimeFns,
  hero: HeroSpec,
  idx: number,
) {
  const now = new Date();
  const teacherId = await deps.provisionTeacherAuthUser(hero.email, hero.name);

  // A PackageTemplate carries its OWN `currency` column, defaulting to MXN.
  // Left unstamped, the JPY teacher would get MXN templates: her booking page
  // would render pesos, and the 0-decimal arithmetic she exists to exercise
  // would never run at all. `currencyForTeacher()` is the app's own version of
  // this rule — the template follows the teacher.
  const templates = [hero.template, ...(hero.extraTemplates ?? [])].map((t) => ({
    ...t,
    ...(hero.pricingCurrency ? { currency: hero.pricingCurrency } : {}),
  }));

  // Wise stays keyed off `wiseOnly` (see the note at the create below);
  // `instruments` is the general form for everything richer.
  const instrumentRows = hero.wiseOnly
    ? [
        {
          kind: "wise" as const,
          enabled: true,
          wiseHandle: hero.key,
          accountHolder: hero.name,
          wiseEmail: hero.email,
        },
      ]
    : (hero.instruments ?? []).map(() => ({
        kind: "wise" as const,
        enabled: true,
        wiseHandle: hero.key,
        accountHolder: hero.name,
        wiseEmail: hero.email,
      }));
  // Null unless this hero opted into a video AND the clip actually landed in
  // the bucket — see seedTeacherIntroVideo on why this one is conditional.
  const introVideoPath = hero.introVideo
    ? await seedTeacherIntroVideo(deps, teacherId, hero.email)
    : null;
  const teacher = await prisma.teacher.create({
    data: {
      // Ownership marker — see the `seeded_at` note in schema.prisma.
      seededAt: new Date(),
      id: teacherId,
      email: hero.email,
      name: hero.name,
      timezone: SEED_TZ,
      // English — the UAT runbook (/admin/uat) assumes an English device and
      // expects English push/email copy for these hero teachers.
      locale: "en",
      bookingSlug: hero.slug,
      headline: hero.headline,
      // hasPhoto/hasBio signals for isPubliclyListed() (D-104). The photo is a
      // monogram generated and uploaded under this hero's own id, so the
      // pointer is true in whichever bucket the seed ran against; bio is a
      // generic placeholder derived from the headline. Neither is asserted by
      // any E2E spec, and heroes with no payout rail (Fernando, Nora) stay
      // unlisted regardless of these two signals — see hasPayoutMethod below.
      photoPath: await seedTeacherPhoto(deps, teacherId, hero.name, hero.email),
      bio: `${hero.headline}.`,
      onboardingCompleteAt: now,
      // Marketplace Ready's other two sub-signals — see the identical comment
      // on Alicia Moreno's teacher.create above.
      templatesTouchedAt: now,
      availabilityTouchedAt: now,
      ...(hero.stripeReady
        ? {
            // paula-pagos is the multi-rail fixture — the only seeded teacher
            // whose checkout offers a card at all alongside the two manual
            // rails — so she is the one a real test-mode account is worth
            // spending on.
            stripeAccountId: seedStripeAccountId(hero.key, hero.key === "paulapagos"),
            stripeChargesEnabled: true,
            stripePayoutsEnabled: true,
          }
        : {}),
      // D-113: the manual rail is a payout-instrument row, not teacher columns.
      //
      // `wiseOnly` stays a distinct flag rather than folding into `instruments`
      // because the Maestro Wise flow depends on those heroes having EXACTLY
      // ONE instrument — a second renders a checkout method picker her flow
      // doesn't expect (the Wise checkout smoke flow, deleted with the app).
      // Heroes that exist to exercise the bank rail or the multi-rail chooser
      // use `instruments` instead, and the spec test asserts no hero sets both.
      ...(instrumentRows.length > 0 ? { payoutInstruments: { create: instrumentRows } } : {}),
      ...(hero.pricingCurrency ? { pricingCurrency: hero.pricingCurrency } : {}),
      ...(hero.country ? { country: hero.country } : {}),
      ...(hero.bookingPageLocale ? { bookingPageLocale: hero.bookingPageLocale } : {}),
      ...(introVideoPath ? { introVideoPath } : {}),
      ...(hero.testimonials?.length
        ? {
            testimonials: {
              create: hero.testimonials.map((t, i) => ({
                authorName: t.authorName,
                authorNote: t.authorNote ?? null,
                body: t.body,
                published: true,
                sortOrder: i,
              })),
            },
          }
        : {}),
      availabilityRules: { create: weekdayAvailability() },
      packageTemplates: { create: templates },
    },
    include: { packageTemplates: true },
  });
  await ensureTeacherLevels(teacherId, prisma);

  await seedSubscription(prisma, teacherId, hero.sub, now, idx);

  const primaryTpl = teacher.packageTemplates.find((t) => t.name === hero.template.name)!;
  // Any hero with a Wise instrument — `wiseOnly` heroes, and now the
  // multi-rail one too. Their students' seeded manual-transfer payments
  // reference it (payments_instrument_required_for_manual_transfer).
  const wiseInstrument = await prisma.teacherPayoutInstrument.findUnique({
    where: { teacherId_kind: { teacherId, kind: "wise" } },
    select: { id: true },
  });
  for (let i = 0; i < hero.students.length; i += 1) {
    const spec = hero.students[i];
    await seedStudentWithUsage(prisma, deps, time, {
      teacherId,
      email: `alumno.${hero.key}.${i + 1}@${HERO_DOMAIN}`,
      routable: true,
      template: primaryTpl,
      spec,
      tz: SEED_TZ,
      wiseInstrumentId: wiseInstrument?.id ?? null,
    });
  }
}

// All loginable hero student emails, derived from the specs (needed up front
// for idempotent cleanup before any rows are created).
export function heroStudentEmails(specs: HeroSpec[]): string[] {
  return specs.flatMap((h) => h.students.map((_, i) => `alumno.${h.key}.${i + 1}@${HERO_DOMAIN}`));
}

// =====================================================================
// Bulk volume (gated by SEED_BULK_TEACHERS).
// =====================================================================

const BULK_FIRST_NAMES = [
  "Adriana",
  "Bernardo",
  "Cecilia",
  "Damián",
  "Eugenia",
  "Federico",
  "Graciela",
  "Hernán",
  "Isabela",
  "Joaquín",
  "Karina",
  "Leonardo",
  "Mariana",
  "Néstor",
  "Olivia",
  "Patricio",
  "Quetzal",
  "Rosaura",
  "Santiago",
  "Teresa",
];
const BULK_LAST_NAMES = [
  "Acosta",
  "Bravo",
  "Castillo",
  "Domínguez",
  "Escobar",
  "Figueroa",
  "Guerrero",
  "Herrera",
  "Ibarra",
  "Jaramillo",
  "Krause",
  "Lozano",
  "Montes",
  "Nieto",
  "Ochoa",
  "Paredes",
  "Quiroz",
  "Robledo",
  "Suárez",
  "Trejo",
];

function bulkName(rng: () => number): string {
  const f = BULK_FIRST_NAMES[Math.floor(rng() * BULK_FIRST_NAMES.length)];
  const l = BULK_LAST_NAMES[Math.floor(rng() * BULK_LAST_NAMES.length)];
  return `${f} ${l}`;
}

const BULK_PLAN_CYCLE: SubSpec[] = [
  { plan: "monthly", status: "active", currentPeriodEndInDays: 15 },
  { plan: "annual", status: "active", currentPeriodEndInDays: 150 },
  { plan: "free", status: "free" },
  { plan: "founding", status: "active", currentPeriodEndInDays: 15 },
  { plan: "free", status: "trialing", trialEndsInDays: 12 },
];

async function seedBulkTeacher(
  prisma: PrismaClient,
  deps: SeedDeps,
  time: TimeFns,
  i: number,
  studentsPer: number,
  idxBase: number,
) {
  const now = new Date();
  const rng = mulberry32(1000 + i);
  const email = `seed-teacher-${i}@${BULK_DOMAIN}`;
  const name = bulkName(rng);
  const teacherId = await deps.provisionTeacherAuthUser(email, name);
  const sub = BULK_PLAN_CYCLE[i % BULK_PLAN_CYCLE.length];

  const teacher = await prisma.teacher.create({
    data: {
      // Ownership marker — see the `seeded_at` note in schema.prisma.
      seededAt: new Date(),
      id: teacherId,
      email,
      name,
      timezone: SEED_TZ,
      locale: "en",
      bookingSlug: `seed-teacher-${i}`,
      // hasPhoto/hasBio/templatesTouched/availabilityTouched signals for
      // isPubliclyListed() (D-104) — see the identical comment on seedHero's
      // teacher.create above.
      photoPath: await seedTeacherPhoto(deps, teacherId, name, email),
      bio: `${name}'s bio.`,
      onboardingCompleteAt: now,
      templatesTouchedAt: now,
      availabilityTouchedAt: now,
      stripeAccountId: `acct_seed_bulk_${i}`,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      availabilityRules: { create: weekdayAvailability() },
      packageTemplates: {
        create: [
          {
            name: "8 clases / 1 mes",
            classCount: 8,
            priceMinorUnits: 240_000,
            expirationMonths: 1,
          },
        ],
      },
    },
    include: { packageTemplates: true },
  });
  await ensureTeacherLevels(teacherId, prisma);
  await seedSubscription(prisma, teacherId, sub, now, idxBase + i);

  const tpl = teacher.packageTemplates[0];
  const hours = [9, 10, 11, 12, 16, 17, 18];
  for (let j = 0; j < studentsPer; j += 1) {
    const used = Math.floor(rng() * 6);
    const expired = rng() < 0.2;
    await seedStudentWithUsage(prisma, deps, time, {
      teacherId,
      email: `seed-student-${i}-${j}@${BULK_DOMAIN}`,
      routable: false,
      template: tpl,
      spec: {
        name: bulkName(rng),
        phone: `+52155570${String(i).padStart(2, "0")}${String(j).padStart(2, "0")}`,
        classesTotal: 8,
        classesUsed: expired ? 8 : used,
        status: expired ? "expired" : "active",
        purchasedDaysAgo: expired ? 60 : 10 + Math.floor(rng() * 15),
        expiresInDays: expired ? -7 : 20 + Math.floor(rng() * 40),
        rail: "card",
        completedOffsets: expired ? [-30, -20, -10] : [-7],
        scheduledOffsets: expired ? [] : [2 + j, 9 + j],
        hour: hours[j % hours.length],
      },
      tz: SEED_TZ,
    });
  }
}

// =====================================================================
// Orchestration.
// =====================================================================

// The seed cleanup disables the append-only `overrides` audit guard and
// hard-deletes teachers, so it must NEVER touch prod — that would erase real
// audit history (D-25) and delete live teachers.
//
// The guard is host-based and ENV-DRIVEN (D-89, post-Supabase): set
// `PROD_DB_HOSTS` — a comma-separated list of the production database
// hostname(s) (Neon pooled + direct) — in any environment where a prod
// connection string could be present (the production deploy env / CI travels
// with the prod creds). The guard then refuses if the seed's DATABASE_URL /
// DIRECT_URL points at one of those hosts. It matches on the DB connection host
// (the actual thing about to be wiped), NOT APP_URL, which defaults to the prod
// domain even in local/test runs. When PROD_DB_HOSTS is unset (local / preview)
// there is no prod DB to protect and the guard is a no-op.
//
// (Pre-D-89 this hardcoded the production Supabase project ref; Supabase is
// decommissioned, so the ref matched nothing and the guard is now keyed off the
// live Neon hosts via this env var.)
function prodDbHosts(): string[] {
  return (process.env.PROD_DB_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostOf(connString: string): string | null {
  try {
    // `.hostname` (not `.host`) so the port is excluded — PROD_DB_HOSTS lists
    // bare hostnames, and a connection string carries `host:5432`.
    return new URL(connString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Hard refusal: throw if the seed is pointed at the production database.
// Checks every connection-bearing env var the seed could be running against.
// Exported for the regression test.
export function assertNotProductionTarget(): void {
  const prodHosts = prodDbHosts();
  if (prodHosts.length === 0) return; // no prod DB configured to guard against

  const connHosts = [process.env.DATABASE_URL, process.env.DIRECT_URL]
    .filter((v): v is string => Boolean(v))
    .map(hostOf)
    .filter((h): h is string => h !== null);

  const prodHost = connHosts.find((h) => prodHosts.includes(h));
  if (prodHost) {
    throw new Error(
      `Refusing to run the seed cleanup against the production database host ` +
        `(${prodHost}): it disables the append-only \`overrides\` audit guard and ` +
        `hard-deletes teachers. The seed is for local/preview only.`,
    );
  }
}

// Run seed-cleanup deletes with the append-only `overrides` guard temporarily
// lifted. The `overrides` audit table is append-only — a row-level trigger
// blocks every DELETE/UPDATE (migration 20260625700000, D-25). On a long-lived
// env like preview a seed teacher accumulates audit rows (Alicia Moreno is
// impersonated from /admin), so the cascade from `teacher.deleteMany` would trip
// that trigger and abort the reseed. The seed's contract is a clean slate, so
// for the cleanup window we drop the *user* triggers on `overrides` (the FK
// cascade is an internal trigger and keeps firing), then restore them — the same
// sanctioned non-prod bypass the test harness gets for free via TRUNCATE, which
// skips row-level triggers too. The seed runs as the table owner (service-role
// `postgres`), so DISABLE/ENABLE TRIGGER is permitted; the DDL and the deletes
// share one transaction, so any failure rolls back with the guard intact (DDL
// is transactional in Postgres). Refuses outright against prod. Exported for the
// regression test.
export async function withOverridesDeletable<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertNotProductionTarget();
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "overrides" DISABLE TRIGGER USER');
      const result = await fn(tx);
      await tx.$executeRawUnsafe('ALTER TABLE "overrides" ENABLE TRIGGER USER');
      return result;
    },
    { timeout: 120_000 },
  );
}

export async function seedAll(
  prisma: PrismaClient,
  deps: SeedDeps,
  opts: SeedOptions,
): Promise<{ teachers: number; students: number; fixtures?: Record<string, number> }> {
  const now = new Date();
  const time = makeTimeFns(now);
  const heroes = heroSpecs();

  // --- Idempotent cleanup. Delete every seed teacher (Alicia + heroes + any bulk,
  // including orphans from a previous larger run) by email; cascades clear
  // their templates / packages / bookings / subscriptions / invoices. Then
  // clear seed students by email.
  //
  // The student delete used to rely on the teacher cascade having already
  // removed everything that FK-restricts a Student — "their FK-restricted rows
  // are already gone". That holds only if every package and booking a seed
  // student owns sits under a seed TEACHER, and a Student is deliberately not
  // scoped that way: one student can belong to several teachers
  // (docs/architecture/multi-teacher-students.md), so a row created against any
  // teacher outside the three email patterns above survives the cascade and
  // then blocks the delete with a RESTRICT violation:
  //
  //   update or delete on table "students" violates RESTRICT setting of
  //   foreign key constraint "packages_student_id_fkey"
  //
  // Preview accumulates exactly those rows — a hand-run checkout, a UAT
  // purchase, anything bought from a teacher this seed does not own — so the
  // seed became un-rerunnable there while still passing everywhere the database
  // was freshly created (CI, local). That is the worst shape for a fixture
  // script: green in every automated run, broken on the one environment a human
  // reseeds by hand.
  //
  // So delete what restricts them explicitly, in FK order. Bookings first:
  // Booking restricts Package as well as Student, so packages cannot go until
  // the bookings referencing them do.
  const heroEmails = heroes.map((h) => h.email);
  const seedStudentWhere = {
    OR: [
      // As above: recorded first, inferred as the legacy fallback.
      { seededAt: { not: null } },
      { email: { in: SEED_STUDENT_EMAILS } },
      { email: { in: heroStudentEmails(heroes) } },
      { email: { endsWith: `@${BULK_DOMAIN}` } },
      // The /admin/uat §B first-time buyer is created on purchase, not
      // seeded — clear it so each reseed leaves §B a genuine first purchase.
      // This one is the likeliest to own rows under a non-seed teacher,
      // because by construction it is created BY a real purchase.
      { email: UAT_BUYER_EMAIL },
    ],
  };
  // Every booking slug this run is about to create. The cleanup used to match
  // teachers by EMAIL alone, but `booking_slug` is independently unique and the
  // seed writes both — so a teacher holding one of these slugs under any other
  // email survives the delete and then collides:
  //
  //   Unique constraint failed on the fields: (`booking_slug`)
  //
  // Which is not hypothetical on preview: it carries an anonymized copy of
  // production, where a real teacher may own the same slug. Same failure shape as
  // the student one above — invisible on a freshly created database (CI,
  // local), fatal on the environment a human actually reseeds.
  //
  // Scoped to exactly the slugs about to be written, so this frees what would
  // collide and nothing else.
  const seedSlugs = ["alicia-moreno", ...heroes.map((h) => h.slug)];
  // Which teacher rows this seed OWNS, however they were named when they were
  // written. Matching on the current email list alone was not enough:
  //
  //   * D-138 renamed the product, and with it every fixture email
  //     (`@agendaprofe.test` → `@spiralclass.test`). Every teacher seeded
  //     before that rename stopped matching, while keeping the booking slugs
  //     and the `acct_seed_*` Stripe ids the new run needs — so the seed could
  //     never re-run on any long-lived database again. Preview was exactly
  //     that: three separate unique constraints failed in sequence
  //     (booking_slug, then stripe_account_id) as each was worked around.
  //   * `acct_seed_*` is written by nothing but this script, so it identifies a
  //     seeded teacher even when the email tells you nothing.
  //
  // The general lesson, worth keeping: a fixture script's idempotency key has
  // to be something the fixture itself controls and never renames. Email was
  // neither.
  const seedTeacherWhere = {
    OR: [
      // The recorded answer. Everything below it is the INFERRED answer, kept
      // only for rows written before this column existed — they carry NULL and
      // can be identified no other way. Once no such rows remain on any
      // long-lived database, the rest of this list can go.
      { seededAt: { not: null } },
      { email: SEED_EMAIL },
      { email: { in: heroEmails } },
      { email: { endsWith: `@${BULK_DOMAIN}` } },
      // Synthetic fixture domains, current and pre-D-138. The rename moved
      // BOTH the `.test` fixture domain and HERO_DOMAIN (`agendaprofe.com` →
      // `spiralclass.com`), so a teacher seeded before it matches none of the
      // current lists.
      { email: { endsWith: "@spiralclass.test" } },
      { email: { endsWith: "@agendaprofe.test" } },
      { email: { endsWith: "@agendaprofe.com" } },
      // Markers no other code path writes. These are the reliable half of the
      // rule: an email can be renamed out from under the seed and was, twice,
      // but a row carrying `acct_seed_*` or `cus_seed_*` was written HERE and
      // nowhere else. A Wise-only hero has no Stripe account id, which is why
      // the subscription marker is needed as well as the account one — that
      // exact gap is what survived the previous fix and failed on
      // `stripe_customer_id`.
      { stripeAccountId: { startsWith: "acct_seed_" } },
      { subscription: { is: { stripeCustomerId: { startsWith: "cus_seed_" } } } },
    ],
  };

  await withOverridesDeletable(prisma, async (tx) => {
    // Packages before the teacher, deliberately.
    //
    // Deleting a teacher cascades to BOTH her packages (→ payments) and her
    // payout instruments, and Postgres gives no ordering guarantee between two
    // cascade paths. `payments.instrument_id` is RESTRICT — on purpose, so
    // deleting an instrument can never delete the payments taken through it —
    // so whenever the instrument path ran first the whole delete failed:
    //
    //   update or delete on table "teacher_payout_instruments" violates
    //   RESTRICT setting of foreign key constraint "payments_instrument_id_fkey"
    //
    // Removing the packages first makes the payments gone before the
    // instruments are touched, so the ordering stops mattering. Bookings lead
    // because Booking restricts Package.
    const doomedTeachers = await tx.teacher.findMany({
      where: seedTeacherWhere,
      select: { id: true },
    });
    const doomedTeacherIds = doomedTeachers.map((t) => t.id);
    if (doomedTeacherIds.length > 0) {
      await tx.booking.deleteMany({ where: { teacherId: { in: doomedTeacherIds } } });
      await tx.package.deleteMany({ where: { teacherId: { in: doomedTeacherIds } } });
    }

    await tx.teacher.deleteMany({ where: seedTeacherWhere });

    // Anyone still holding a slug this run needs, who the email delete above
    // did not own. On preview that is the anonymized production copy, which
    // legitimately owns `alicia-moreno`.
    //
    // DISPLACED, not deleted. The seed needs the slug free; it does not need
    // the row gone, and deleting a foreign teacher's whole graph means walking
    // four more RESTRICT chains (payments → payout instruments, bookings →
    // packages, focus tags → categories, social previews → images) to destroy
    // data this script never created and nobody asked it to remove. Renaming
    // costs one UPDATE and leaves the row inspectable.
    //
    // Idempotent: a displaced teacher no longer matches, so re-running does
    // not rename it again or collide with the previous suffix.
    // Anything still holding a seed slug after the delete above is, by
    // definition, not ours.
    const squatters = await tx.teacher.findMany({
      where: { bookingSlug: { in: seedSlugs } },
      select: { id: true, bookingSlug: true },
    });
    for (const squatter of squatters) {
      await tx.teacher.update({
        where: { id: squatter.id },
        data: { bookingSlug: `displaced-${squatter.id.slice(0, 8)}` },
      });
    }

    // Whatever survived the cascade because it belongs to a teacher this seed
    // does not own. Resolved to ids first so the two deletes below target
    // exactly the students the delete after them will remove.
    const doomed = await tx.student.findMany({ where: seedStudentWhere, select: { id: true } });
    const doomedIds = doomed.map((s) => s.id);
    if (doomedIds.length > 0) {
      await tx.booking.deleteMany({ where: { studentId: { in: doomedIds } } });
      await tx.package.deleteMany({ where: { studentId: { in: doomedIds } } });
    }

    await tx.student.deleteMany({ where: seedStudentWhere });
  });

  // --- Alicia Moreno (E2E-critical) — unchanged shape. ---
  const anaId = await deps.provisionTeacherAuthUser(SEED_EMAIL, "Alicia Moreno");
  const { inMx } = time;

  const teacher = await prisma.teacher.create({
    data: {
      // Ownership marker — see the `seeded_at` note in schema.prisma.
      seededAt: new Date(),
      id: anaId,
      email: SEED_EMAIL,
      name: "Alicia Moreno",
      timezone: SEED_TZ,
      bookingSlug: "alicia-moreno",
      // Her profile photo: a monogram this script generates and uploads into
      // the public teacher-photos bucket under her own id (teacher photos are
      // keyed by teacher id). Set so /b/alicia-moreno renders the avatar on
      // preview — the anonymized sync nulls every teacher's photo_path, so the
      // re-seed is the only place it comes back. Resolves to null (no image,
      // initials monogram instead) in envs without R2 configured (local).
      photoPath: await seedTeacherPhoto(deps, anaId, "Alicia Moreno", SEED_EMAIL),
      // Real short bio text — isPubliclyListed()'s hasBio signal (D-104) needs
      // this non-null, same as templatesTouchedAt/availabilityTouchedAt below.
      bio: "Profesora de inglés con más de 10 años de experiencia enseñando a adultos.",
      onboardingCompleteAt: now,
      // Marketplace Ready's other two sub-signals (D-104, isMarketplaceReady()):
      // "reviewed the offer" / "reviewed the schedule". Every seed teacher is
      // meant to represent an already-active real teacher, not one mid-wizard,
      // so both stamp to `now` alongside the templates/availability they're
      // created with below.
      templatesTouchedAt: now,
      availabilityTouchedAt: now,
      // Stub Stripe Connect so /b/alicia-moreno/comprar renders the purchase form
      // enabled (the E2E happy path depends on this).
      stripeAccountId: "acct_seed_alicia_moreno_stub",
      stripeChargesEnabled: true,
      availabilityRules: { create: weekdayAvailability() },
      packageTemplates: {
        create: [
          {
            name: "4 clases / 1 mes",
            classCount: 4,
            priceMinorUnits: 130_000,
            expirationMonths: 1,
          },
          {
            name: "8 clases / 1 mes",
            classCount: 8,
            priceMinorUnits: 240_000,
            expirationMonths: 1,
          },
          {
            name: "10 clases / 3 meses",
            classCount: 10,
            priceMinorUnits: 280_000,
            expirationMonths: 3,
          },
          {
            name: "20 clases / 5 meses",
            classCount: 20,
            priceMinorUnits: 550_000,
            expirationMonths: 5,
          },
        ],
      },
    },
    include: { packageTemplates: true },
  });
  await ensureTeacherLevels(anaId, prisma);

  // The seeded founding teacher carries the comped flag, so the entitlements
  // resolver's comped branch has a fixture.
  await prisma.teacherSubscription.create({
    data: {
      teacherId: anaId,
      plan: "founding",
      status: "active",
      comped: true,
      lockedPriceMinorUnits: PLAN_PRICE_MINOR_UNITS.founding,
      currentPeriodEnd: addDays(now, 30),
    },
  });

  const tpl8f = teacher.packageTemplates.find((t) => t.name === "8 clases / 1 mes")!;
  const tpl10f = teacher.packageTemplates.find((t) => t.name === "10 clases / 3 meses")!;
  const tpl20f = teacher.packageTemplates.find((t) => t.name === "20 clases / 5 meses")!;

  const maria = await prisma.student.create({
    data: {
      // Ownership marker — see the `seeded_at` note in schema.prisma.
      seededAt: new Date(),
      id: randomUUID(),
      email: "maria@alumno.test",
      name: "María Hernández",
      locale: "es-MX",
      phoneE164: "+5215555000001",
      teacherStudents: { create: { teacherId: anaId } },
    },
  });
  const carlos = await prisma.student.create({
    data: {
      // Ownership marker — see the `seeded_at` note in schema.prisma.
      seededAt: new Date(),
      id: randomUUID(),
      email: "carlos@alumno.test",
      name: "Carlos Ruiz",
      locale: "es-MX",
      phoneE164: "+5215555000002",
      teacherStudents: { create: { teacherId: anaId } },
    },
  });
  const sofia = await prisma.student.create({
    data: {
      // Ownership marker — see the `seeded_at` note in schema.prisma.
      seededAt: new Date(),
      id: randomUUID(),
      email: "sofia@alumno.test",
      name: "Sofía Ortega",
      locale: "es-MX",
      phoneE164: "+5215555000003",
      teacherStudents: { create: { teacherId: anaId } },
    },
  });
  const marcela = await prisma.student.create({
    data: {
      // Ownership marker — see the `seeded_at` note in schema.prisma.
      seededAt: new Date(),
      id: randomUUID(),
      email: "marcela@alumno.test",
      name: "Marcela Rivera",
      locale: "es-MX",
      phoneE164: "+5215555000004",
      teacherStudents: { create: { teacherId: anaId } },
    },
  });

  const mariaPkg = await prisma.package.create({
    data: {
      teacherId: anaId,
      studentId: maria.id,
      templateId: tpl20f.id,
      classesTotal: 20,
      classesUsed: 3,
      pricePaidMinorUnits: 550_000,
      purchasedAt: addDays(now, -30),
      expiresAt: addDays(now, 120),
      status: "active",
    },
  });
  const carlosPkg = await prisma.package.create({
    data: {
      teacherId: anaId,
      studentId: carlos.id,
      templateId: tpl8f.id,
      classesTotal: 8,
      classesUsed: 2,
      pricePaidMinorUnits: 240_000,
      purchasedAt: addDays(now, -10),
      expiresAt: addDays(now, 20),
      status: "active",
    },
  });
  await prisma.package.create({
    data: {
      teacherId: anaId,
      studentId: sofia.id,
      templateId: tpl20f.id,
      classesTotal: 20,
      classesUsed: 18,
      pricePaidMinorUnits: 550_000,
      purchasedAt: addDays(now, -160),
      expiresAt: addDays(now, -7),
      status: "expired",
    },
  });
  const marcelaPkg = await prisma.package.create({
    data: {
      teacherId: anaId,
      studentId: marcela.id,
      templateId: tpl10f.id,
      classesTotal: 10,
      classesUsed: 1,
      pricePaidMinorUnits: 280_000,
      purchasedAt: addDays(now, -12),
      expiresAt: addDays(now, 78),
      status: "active",
    },
  });

  const snap = (d: Date) => nextWeekdayMatching(d, SEED_WEEKDAYS);
  const at10 = (day: Date) => inMx(new Date(startOfDay(snap(day)).getTime() + 10 * 3600_000));
  const at17 = (day: Date) => inMx(new Date(startOfDay(snap(day)).getTime() + 17 * 3600_000));
  const mins = (n: number) => n * 60_000;

  await prisma.booking.createMany({
    data: [
      {
        packageId: mariaPkg.id,
        teacherId: anaId,
        studentId: maria.id,
        scheduledStart: at10(addDays(now, -14)),
        scheduledEnd: new Date(at10(addDays(now, -14)).getTime() + mins(50)),
        status: "completed",
        completedAt: addDays(now, -14),
      },
      {
        packageId: mariaPkg.id,
        teacherId: anaId,
        studentId: maria.id,
        scheduledStart: at10(addDays(now, -7)),
        scheduledEnd: new Date(at10(addDays(now, -7)).getTime() + mins(50)),
        status: "completed",
        completedAt: addDays(now, -7),
      },
      {
        packageId: mariaPkg.id,
        teacherId: anaId,
        studentId: maria.id,
        scheduledStart: at10(addDays(now, -3)),
        scheduledEnd: new Date(at10(addDays(now, -3)).getTime() + mins(50)),
        status: "canceled_by_student",
      },
      {
        packageId: mariaPkg.id,
        teacherId: anaId,
        studentId: maria.id,
        scheduledStart: at10(addDays(now, 2)),
        scheduledEnd: new Date(at10(addDays(now, 2)).getTime() + mins(50)),
        status: "scheduled",
      },
      {
        packageId: mariaPkg.id,
        teacherId: anaId,
        studentId: maria.id,
        scheduledStart: at10(addDays(now, 9)),
        scheduledEnd: new Date(at10(addDays(now, 9)).getTime() + mins(50)),
        status: "scheduled",
      },
    ],
  });
  await prisma.booking.createMany({
    data: [
      {
        packageId: carlosPkg.id,
        teacherId: anaId,
        studentId: carlos.id,
        scheduledStart: at17(addDays(now, -10)),
        scheduledEnd: new Date(at17(addDays(now, -10)).getTime() + mins(50)),
        status: "completed",
        completedAt: addDays(now, -10),
      },
      {
        packageId: carlosPkg.id,
        teacherId: anaId,
        studentId: carlos.id,
        scheduledStart: at17(addDays(now, -3)),
        scheduledEnd: new Date(at17(addDays(now, -3)).getTime() + mins(50)),
        status: "completed",
        completedAt: addDays(now, -3),
      },
      {
        packageId: carlosPkg.id,
        teacherId: anaId,
        studentId: carlos.id,
        scheduledStart: at17(addDays(now, 4)),
        scheduledEnd: new Date(at17(addDays(now, 4)).getTime() + mins(50)),
        status: "scheduled",
      },
      {
        packageId: carlosPkg.id,
        teacherId: anaId,
        studentId: carlos.id,
        scheduledStart: at17(addDays(now, 11)),
        scheduledEnd: new Date(at17(addDays(now, 11)).getTime() + mins(50)),
        status: "scheduled",
      },
    ],
  });
  await prisma.booking.createMany({
    data: [
      {
        packageId: marcelaPkg.id,
        teacherId: anaId,
        studentId: marcela.id,
        scheduledStart: at10(addDays(now, -10)),
        scheduledEnd: new Date(at10(addDays(now, -10)).getTime() + mins(50)),
        status: "completed",
        completedAt: addDays(now, -10),
      },
      {
        packageId: marcelaPkg.id,
        teacherId: anaId,
        studentId: marcela.id,
        scheduledStart: at10(addDays(now, 5)),
        scheduledEnd: new Date(at10(addDays(now, 5)).getTime() + mins(50)),
        status: "scheduled",
      },
      {
        packageId: marcelaPkg.id,
        teacherId: anaId,
        studentId: marcela.id,
        scheduledStart: at10(addDays(now, 12)),
        scheduledEnd: new Date(at10(addDays(now, 12)).getTime() + mins(50)),
        status: "scheduled",
      },
    ],
  });

  // Class material for one of María's upcoming bookings.
  const mariaUpcoming = await prisma.booking.findFirst({
    where: { studentId: maria.id, status: "scheduled" },
    orderBy: { scheduledStart: "asc" },
    select: { id: true },
  });
  if (mariaUpcoming) {
    const storagePath = `${anaId}/${mariaUpcoming.id}/seed-material.pdf`;
    try {
      const buffer = readFileSync(resolve(process.cwd(), "tests/_fixtures/seed-material.pdf"));
      const up = await deps.uploadMaterial(storagePath, buffer);
      if (!up.ok) console.warn(`  fixture upload skipped (${up.error ?? "unknown"})`);
      else console.log(`  uploaded seed material to ${storagePath}`);
    } catch (e) {
      console.warn(`  fixture read skipped (${(e as Error).message})`);
    }
    await prisma.libraryMaterial.create({
      data: {
        teacherId: anaId,
        bookingId: mariaUpcoming.id,
        visibility: "at_or_below",
        storagePath,
        label: "Tarea pre-clase",
        sendTiming: "t_24h",
      },
    });
  }

  // --- Hero teachers (subscription + payment-rail matrix). ---
  for (let i = 0; i < heroes.length; i += 1) {
    await seedHero(prisma, deps, time, heroes[i], i + 1);
    console.log(`  hero: ${heroes[i].email} (${heroes[i].sub.plan}/${heroes[i].sub.status})`);
  }

  // --- Optional bulk volume. ---
  for (let i = 0; i < opts.bulkTeachers; i += 1) {
    await seedBulkTeacher(prisma, deps, time, i, opts.studentsPerBulkTeacher, 1000);
  }
  if (opts.bulkTeachers > 0) {
    console.log(`  bulk: ${opts.bulkTeachers} teachers × ${opts.studentsPerBulkTeacher} students`);
  }

  // The smoke-late-cancel.yaml fixture (a dedicated student with a <24h-out
  // scheduled booking) is NOT seeded here — a `now + 20h` booking would decay
  // into the past within a day of the seed. It's minted fresh at flow run time
  // by the deleted fixture route (step 4), so it never depends on
  // when the seed last ran.

  // Onboarding fixture (smoke-teacher-onboarding.yaml): a teacher parked at the
  // pre-onboarding state — `onboardingCompleteAt` null, no availability rules,
  // no package templates — so on sign-in the app routes into the 4-step
  // onboarding wizard. The flow walks the steps but never taps "Finish", so this
  // teacher stays onboarding-incomplete and the fixture is reusable across runs.
  // Cleaned up by the @BULK_DOMAIN sweep at the top of seedAll like every other
  // seed row.
  if (opts.bulkTeachers >= 1) {
    const onbEmail = `seed-teacher-onboarding@${BULK_DOMAIN}`;
    const onbId = await deps.provisionTeacherAuthUser(onbEmail, "Onboarding Fixture");
    await prisma.teacher.create({
      data: {
        // Ownership marker — see the `seeded_at` note in schema.prisma.
        seededAt: new Date(),
        id: onbId,
        email: onbEmail,
        name: "Onboarding Fixture",
        timezone: SEED_TZ,
        locale: "en",
        bookingSlug: "seed-teacher-onboarding",
        // onboardingCompleteAt intentionally omitted (null) → routes into the
        // onboarding wizard. No availabilityRules / packageTemplates on purpose.
      },
    });
    await seedSubscription(
      prisma,
      onbId,
      { plan: "free", status: "trialing", trialEndsInDays: 30 },
      now,
      9000,
    );
    console.log(`  onboarding fixture: ${onbEmail}`);
  }

  // Self-book fixture (smoke-teacher-self-book.yaml): a student under
  // seed-teacher-1 with a guaranteed fresh ACTIVE package (classes remaining),
  // given a fixed NAME so the flow selects it by name — the teacher's student
  // list is ordered createdAt-desc and seam-created students shuffle the index,
  // so a positional `book-student-0` can't be relied on to have a bookable
  // package. Cleaned up by the @BULK_DOMAIN sweep like every other seed row.
  if (opts.bulkTeachers >= 2) {
    const sbTeacher = await prisma.teacher.findUnique({
      where: { email: `seed-teacher-1@${BULK_DOMAIN}` },
      include: { packageTemplates: true },
    });
    const sbTpl = sbTeacher?.packageTemplates[0];
    if (sbTeacher && sbTpl) {
      const sbStudent = await prisma.student.create({
        data: {
          // Ownership marker — see the `seeded_at` note in schema.prisma.
          seededAt: new Date(),
          id: randomUUID(),
          email: `seed-student-selfbook@${BULK_DOMAIN}`,
          name: "Self Book Fixture",
          locale: "en",
          teacherStudents: { create: { teacherId: sbTeacher.id } },
        },
      });
      await prisma.package.create({
        data: {
          teacherId: sbTeacher.id,
          studentId: sbStudent.id,
          templateId: sbTpl.id,
          classesTotal: 8,
          classesUsed: 0,
          pricePaidMinorUnits: sbTpl.priceMinorUnits,
          purchasedAt: addDays(now, -2),
          expiresAt: addDays(now, 28),
          status: "active",
        },
      });
      console.log(`  self-book fixture: seed-student-selfbook@${BULK_DOMAIN}`);
    }
  }

  // --- Founding cohort headcount = count of founding subscriptions. ---
  const foundingCount = await prisma.teacherSubscription.count({
    where: { plan: "founding" },
  });
  await prisma.foundingCohort.upsert({
    where: { id: "default" },
    create: { id: "default", headcount: foundingCount },
    update: { headcount: foundingCount },
  });

  // Everything the spine above does not build: the taxonomy, the class
  // artefacts, homework, messages, notifications, marketing, the platform
  // tables and better-auth's own. Runs last because it reads back what the
  // heroes and bulk teachers created rather than being threaded through them.
  const fixtures = await seedFixtures(prisma, now);
  const fixtureRows = Object.values(fixtures).reduce((a, b) => a + b, 0);
  if (fixtureRows > 0) {
    console.log(`  fixtures: ${fixtureRows} rows across ${Object.keys(fixtures).length} models`);
  }

  const teachers = await prisma.teacher.count();
  const students = await prisma.student.count();
  return { teachers, students, fixtures };
}

// =====================================================================
// Real entry point (Postgres + R2 — portable, no Supabase dependency).
// =====================================================================

// Load every existing better-auth `user` row into an email→id map once, so
// reseeds reuse ids without a lookup per teacher (mirrors the old
// Supabase-auth-user map this replaced, keyed the same way).
async function loadUserIdByEmailMap(prisma: PrismaClient): Promise<Map<string, string>> {
  const rows = await prisma.user.findMany({ select: { id: true, email: true } });
  return new Map(rows.map((r) => [r.email, r.id]));
}

// Exported so the /admin/uat Reseed action's Inngest function (D-55) can call
// the exact same seeding path as the CLI, rather than duplicating the
// user-provisioning / storage upload wiring above. `opts` lets that caller
// pass the same bulk-volume knobs the CLI reads from
// SEED_BULK_TEACHERS/SEED_BULK_STUDENTS_PER_TEACHER — falls back to those env
// vars when omitted, so `pnpm seed:preview` behaves exactly as before.
export async function main(opts?: {
  bulkTeachers?: number;
  studentsPerBulkTeacher?: number;
}): Promise<{ teachers: number; students: number }> {
  // Seed over the DIRECT (session-mode) connection, not the transaction pooler.
  // A pooled `DATABASE_URL` (pgbouncer/Supavisor) rotates server connections
  // per-transaction and so breaks Prisma's prepared statements under a long
  // bulk run ("prepared statement sNN does not exist"). `DIRECT_URL` is the
  // same connection `prisma migrate deploy` uses — correct for a one-shot bulk
  // script. Falls back to DATABASE_URL when no direct URL is configured (e.g.
  // a plain local Postgres).
  const seedUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!seedUrl) throw new Error("Neither DIRECT_URL nor DATABASE_URL is set.");
  const prisma = new PrismaClient({ adapter: pgAdapter(seedUrl) });

  const userMap = await loadUserIdByEmailMap(prisma);

  // D-40: teachers.id / students.auth_user_id FK to better-auth's own `user`
  // table. Every seeded person needs a matching `user` row before the
  // teacher/student insert that references it. Idempotent (ON CONFLICT DO
  // NOTHING).
  async function ensureUserRow(id: string, email: string, name: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, $2, $3, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
      id,
      name,
      email,
    );
  }

  await getStorageProvider().ensureBucket(MATERIALS_BUCKET);
  // Public bucket, self-provisioning — same call the teacher's own photo upload
  // makes, so a fresh preview/local env gets the bucket with the right MIME
  // allowlist and size limit rather than failing every photo upload below.
  await ensureTeacherPhotoBucket().catch(() => {});
  await ensureTeacherVideoBucket().catch(() => {});

  const deps: SeedDeps = {
    async provisionTeacherAuthUser(email, name) {
      const existing = userMap.get(email);
      if (existing) {
        await ensureUserRow(existing, email, name);
        return existing;
      }
      const id = randomUUID();
      userMap.set(email, id);
      await ensureUserRow(id, email, name);
      return id;
    },
    async ensureStudentAuthUser(email) {
      const existing = userMap.get(email);
      if (existing) {
        await ensureUserRow(existing, email, email.split("@")[0] ?? "Student");
        return;
      }
      const id = randomUUID();
      userMap.set(email, id);
      await ensureUserRow(id, email, email.split("@")[0] ?? "Student");
    },
    async uploadMaterial(storagePath, pdf) {
      const { error } = await getStorageProvider().upload(MATERIALS_BUCKET, storagePath, pdf, {
        contentType: "application/pdf",
        upsert: true,
      });
      return error ? { ok: false, error: error.message } : { ok: true };
    },
    async uploadTeacherPhoto(teacherId, png) {
      const { error } = await getStorageProvider().upload(
        TEACHER_PHOTO_BUCKET,
        teacherPhotoStorageKey(teacherId),
        png,
        {
          contentType: "image/png",
          upsert: true,
          // Safe here for the same reason putTeacherPhoto uses it: the public
          // URL always carries a `?v=` cache-buster (teacherPhotoPublicUrl).
          cacheControl: PUBLIC_VERSIONED_ASSET_CACHE_CONTROL,
        },
      );
      return error ? { ok: false, error: error.message } : { ok: true };
    },
    async uploadTeacherVideo(teacherId, mp4) {
      const { error } = await getStorageProvider().upload(
        TEACHER_VIDEO_BUCKET,
        teacherVideoStorageKey(teacherId),
        mp4,
        {
          contentType: SEED_VIDEO_CONTENT_TYPE,
          upsert: true,
          cacheControl: PUBLIC_VERSIONED_ASSET_CACHE_CONTROL,
        },
      );
      return error ? { ok: false, error: error.message } : { ok: true };
    },
  };

  const bulkTeachers = opts?.bulkTeachers ?? (Number(process.env.SEED_BULK_TEACHERS ?? "0") || 0);
  const studentsPerBulkTeacher =
    opts?.studentsPerBulkTeacher ??
    (Number(process.env.SEED_BULK_STUDENTS_PER_TEACHER ?? "6") || 6);

  const summary = await seedAll(prisma, deps, { bulkTeachers, studentsPerBulkTeacher });

  // Ensure these operator/tester `admin_users` rows always exist after a
  // reseed. admin_users isn't part of the teacher/student clean-slate reset
  // above (D-25 — admins are hand-invited, never wiped like seed fixtures),
  // but a fresh/empty preview DB has NO admin_users rows at all, so an
  // operator would otherwise depend on the fragile SUPERUSER_EMAILS
  // bootstrap window — which permanently deactivates the instant ANY
  // admin_users row is created (see lib/admin.ts's loadAdminActor comment).
  // Idempotent; scoped to main() (never seedAll(), which the test harness
  // also calls against a plain non-Supabase Postgres DB) since these are
  // real people's accounts, not generic fixtures.
  for (const admin of [
    { email: OPERATOR_EMAIL, role: "superadmin" as const },
    { email: PILOT_TEACHER_EMAIL, role: "tester" as const },
  ]) {
    await prisma.adminUser.upsert({
      where: { email: admin.email },
      create: { email: admin.email, role: admin.role },
      update: { role: admin.role, disabledAt: null },
    });
  }

  // Financial Intelligence estimate layer (D-86, S2) — same rationale as the
  // admin_users loop above: a platform-wide registry, not a per-teacher/
  // student fixture, so it's create-if-absent here in main() rather than in
  // seedAll() (which the integration test harness also calls against a
  // plain non-Supabase Postgres DB and resets on every run).
  await ensureIntegrationsSeeded(prisma);
  // …then push the current KNOWN_INTEGRATIONS defaults onto any un-edited rows,
  // so a preview reseed picks up a pricing recalibration that create-if-absent
  // (skipDuplicates) would otherwise skip on already-seeded rows. Never touches
  // an admin-edited row. seed.ts is preview/local-only (assertNotProductionTarget),
  // so this can't reach production.
  await refreshDefaultIntegrations(prisma);

  console.log("✓ seed complete");
  console.log(`  teachers: ${summary.teachers}, students: ${summary.students}`);
  console.log(`  teacher sign-in (E2E): ${SEED_EMAIL} (email-OTP, passwordless)`);
  console.log(`  hero logins: profe.*@${HERO_DOMAIN} (magic-link or admin impersonation)`);
  await prisma.$disconnect();
  return summary;
}

// Only run main() when invoked directly (not when imported by the test harness).
if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  main().catch(async (err) => {
    console.error(err);
    process.exit(1);
  });
}
