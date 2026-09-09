// Teacher roster importer. Loads a teacher's existing students, package
// balances, and committed agenda from three CSVs (see ./README.md) directly
// into the database. Service-role: bypasses RLS. SILENT by design — it emits
// no Inngest events, so no confirmations/reminders/push/email ever fire.
//
// This is a one-time onboarding/migration tool, parameterized by --teacher so
// it works for any teacher, not just the first. Day-to-day activity flows
// through the public funnel, not this script.
//
// Usage:
//   pnpm import --teacher <slug-or-id> --dir <folder-with-3-csvs>           # dry run
//   pnpm import --teacher <slug-or-id> --dir <folder-with-3-csvs> --commit  # write
//
// Idempotent: row identity is a deterministic UUID derived from the *_ref
// columns, so re-running with the same refs updates rows in place. It never
// deletes — a row removed from a CSV stays in the DB (remove it in the app).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fromZonedTime } from "date-fns-tz";
import { PrismaClient, type Prisma } from "@prisma/client";
import { envAdapter } from "@/lib/db-pool";
import { z } from "zod";

const DEFAULT_TZ = "America/Mexico_City";
const DEFAULT_LOCALE = "es-MX";
const DEFAULT_DURATION_MIN = 50;

// Imported students never opted into platform comms — start them with every
// lifecycle notification category OFF. Mirrors allDisabledPrefs() in
// src/lib/notifications/preferences.ts (kept inline so this CLI has no
// app-internal import). Set on INSERT only; a re-run won't reset a student
// who has since turned notifications back on.
const IMPORTED_NOTIFICATION_PREFS = {
  class_reminders: false,
  booking_updates: false,
  class_materials: false,
  expiry_reminders: false,
  messages: false,
};

// --- CLI args ---

interface Args {
  teacher: string;
  dir: string;
  commit: boolean;
  // When set, skip the DB entirely and print the idempotent upsert SQL to
  // stdout instead of writing via Prisma. For environments that can only
  // reach the target DB through a SQL console / MCP (no direct connection
  // string). In this mode `--teacher` MUST be the teacher's UUID (it's used
  // verbatim as the deterministic-id namespace; there's no DB to resolve a
  // slug against). Reconciliation still prints to stderr.
  emitSql: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const teacher = get("--teacher");
  const dir = get("--dir");
  const commit = argv.includes("--commit");
  const emitSql = argv.includes("--emit-sql");
  if (!teacher || !dir) {
    throw new Error(
      "Usage: pnpm import --teacher <slug-or-id> --dir <folder> [--commit] [--emit-sql]",
    );
  }
  return { teacher, dir, commit, emitSql };
}

// --- Deterministic UUID (uuid v5-shaped) ---
// Stable id from (namespace, name) so re-runs upsert the same rows without a
// dedicated key column. Namespace is the teacher id, scoping refs per teacher.

function deterministicUuid(namespace: string, name: string): string {
  const h = createHash("sha1").update(`${namespace}:${name}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- Minimal CSV parser ---
// Handles quoted fields, embedded commas/newlines, and "" escaping. Returns
// one object per data row keyed by the (trimmed) header names, plus the 1-based
// source line for error reporting.

interface Row {
  _line: number;
  [col: string]: string | number;
}

function parseCsv(text: string, file: string): Row[] {
  const fields: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const lineStarts: number[] = [];
  let line = 1;
  lineStarts.push(1);

  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    fields.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      pushCell();
    } else if (c === "\r") {
      // swallow; handled by \n
    } else if (c === "\n") {
      pushRow();
      line++;
      lineStarts.push(line);
    } else {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) pushRow();

  const nonEmpty = fields.filter((r) => r.some((v) => v.trim() !== ""));
  if (nonEmpty.length === 0) {
    throw new Error(`${file}: no rows found`);
  }
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r, idx) => {
    const obj: Row = { _line: idx + 2 };
    header.forEach((h, ci) => {
      obj[h] = (r[ci] ?? "").trim();
    });
    return obj;
  });
}

// --- Schemas ---

const str = (max = 500) => z.string().trim().max(max);
const optStr = z
  .string()
  .trim()
  .transform((s) => (s === "" ? undefined : s))
  .optional();

const studentSchema = z.object({
  student_ref: str(120).min(1),
  name: str(200).min(1),
  email: z
    .string()
    .trim()
    .transform((s) => (s === "" ? undefined : s.toLowerCase()))
    .pipe(z.string().email().optional()),
  phone: optStr.refine((v) => v === undefined || /^\+[1-9]\d{6,14}$/.test(v), {
    message: "phone must be E.164, e.g. +5215555000001",
  }),
  timezone: optStr,
  locale: optStr,
});

const intFrom = (label: string) =>
  z
    .string()
    .trim()
    .refine((s) => /^\d+$/.test(s), { message: `${label} must be a whole number` })
    .transform((s) => parseInt(s, 10));

const dateOnly = (label: string) =>
  z
    .string()
    .trim()
    .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s), {
      message: `${label} must be YYYY-MM-DD`,
    });

const packageSchema = z
  .object({
    package_ref: str(120).min(1),
    student_ref: str(120).min(1),
    classes_total: intFrom("classes_total"),
    classes_used: intFrom("classes_used"),
    price_paid_mxn: z
      .string()
      .trim()
      .refine((s) => /^\d+(\.\d{1,2})?$/.test(s), {
        message: "price_paid_mxn must be pesos, e.g. 5500 or 5500.50",
      })
      .transform((s) => Math.round(parseFloat(s) * 100)),
    purchased_date: dateOnly("purchased_date"),
    expires_date: z
      .string()
      .trim()
      .transform((s) => (s === "" ? undefined : s))
      .refine((s) => s === undefined || /^\d{4}-\d{2}-\d{2}$/.test(s), {
        message: "expires_date must be YYYY-MM-DD or blank",
      }),
    status: z
      .string()
      .trim()
      .transform((s) => (s === "" ? "active" : s))
      .pipe(z.enum(["active", "paused", "expired"])),
  })
  .refine((p) => p.classes_used <= p.classes_total, {
    message: "classes_used cannot exceed classes_total",
  });

const bookingSchema = z.object({
  student_ref: str(120).min(1),
  package_ref: str(120).min(1),
  start_datetime: z
    .string()
    .trim()
    .refine((s) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(s), {
      message: "start_datetime must be 'YYYY-MM-DD HH:MM'",
    }),
  duration_min: z
    .string()
    .trim()
    .transform((s) => (s === "" ? DEFAULT_DURATION_MIN : parseInt(s, 10)))
    .refine((n) => Number.isInteger(n) && n > 0, {
      message: "duration_min must be a positive whole number",
    }),
  status: z.enum(["scheduled", "completed"]),
});

type StudentRow = z.infer<typeof studentSchema> & { _line: number };
type PackageRow = z.infer<typeof packageSchema> & { _line: number };
type BookingRow = z.infer<typeof bookingSchema> & { _line: number };

// --- Validation ---

interface Issue {
  file: string;
  line: number;
  message: string;
}

function validateFile<T>(
  rows: Row[],
  file: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  issues: Issue[],
): (T & { _line: number })[] {
  const out: (T & { _line: number })[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      for (const e of parsed.error.errors) {
        issues.push({
          file,
          line: row._line,
          message: `${e.path.join(".") || "row"}: ${e.message}`,
        });
      }
    } else {
      out.push({ ...(parsed.data as T), _line: row._line });
    }
  }
  return out;
}

function crossValidate(
  students: StudentRow[],
  packages: PackageRow[],
  bookings: BookingRow[],
  issues: Issue[],
): void {
  // Duplicate refs.
  const seenStudent = new Set<string>();
  for (const s of students) {
    if (seenStudent.has(s.student_ref)) {
      issues.push({
        file: "students.csv",
        line: s._line,
        message: `duplicate student_ref '${s.student_ref}'`,
      });
    }
    seenStudent.add(s.student_ref);
  }
  const seenPackage = new Set<string>();
  for (const p of packages) {
    if (seenPackage.has(p.package_ref)) {
      issues.push({
        file: "packages.csv",
        line: p._line,
        message: `duplicate package_ref '${p.package_ref}'`,
      });
    }
    seenPackage.add(p.package_ref);
  }

  // FK refs.
  const pkgByRef = new Map(packages.map((p) => [p.package_ref, p]));
  for (const p of packages) {
    if (!seenStudent.has(p.student_ref)) {
      issues.push({
        file: "packages.csv",
        line: p._line,
        message: `student_ref '${p.student_ref}' not found in students.csv`,
      });
    }
  }
  for (const b of bookings) {
    if (!seenStudent.has(b.student_ref)) {
      issues.push({
        file: "bookings.csv",
        line: b._line,
        message: `student_ref '${b.student_ref}' not found in students.csv`,
      });
    }
    const pkg = pkgByRef.get(b.package_ref);
    if (!pkg) {
      issues.push({
        file: "bookings.csv",
        line: b._line,
        message: `package_ref '${b.package_ref}' not found in packages.csv`,
      });
    } else if (pkg.student_ref !== b.student_ref) {
      issues.push({
        file: "bookings.csv",
        line: b._line,
        message: `package '${b.package_ref}' belongs to '${pkg.student_ref}', not '${b.student_ref}'`,
      });
    }
  }
}

// --- Date helpers ---

function packageDate(dateStr: string, tz: string): Date {
  return fromZonedTime(`${dateStr}T00:00:00`, tz);
}

function bookingStart(startStr: string, tz: string): Date {
  return fromZonedTime(startStr.replace(" ", "T") + ":00", tz);
}

// --- Main ---

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(process.cwd(), args.dir);

  const read = (name: string) => parseCsv(readFileSync(resolve(dir, name), "utf8"), name);
  const studentRows = read("students.csv");
  const packageRows = read("packages.csv");
  const bookingRows = read("bookings.csv");

  // Validation + reconciliation run fully offline — no DB needed to check a
  // teacher's CSVs. The DB is only touched to resolve the teacher and write.
  const issues: Issue[] = [];
  const students = validateFile(studentRows, "students.csv", studentSchema, issues);
  const packages = validateFile(packageRows, "packages.csv", packageSchema, issues);
  const bookings = validateFile(bookingRows, "bookings.csv", bookingSchema, issues);
  crossValidate(students, packages, bookings, issues);

  // Resolve per-student timezone (used for both package + booking datetimes).
  const tzByStudent = new Map(students.map((s) => [s.student_ref, s.timezone ?? DEFAULT_TZ]));

  // Slot-collision check across scheduled bookings (one active class per
  // teacher start time). Done on derived UTC starts so it matches the DB
  // unique index.
  const startSeen = new Map<string, number>();
  for (const b of bookings) {
    if (b.status !== "scheduled") continue;
    const tz = tzByStudent.get(b.student_ref) ?? DEFAULT_TZ;
    const key = bookingStart(b.start_datetime, tz).toISOString();
    if (startSeen.has(key)) {
      issues.push({
        file: "bookings.csv",
        line: b._line,
        message: `scheduled slot ${b.start_datetime} collides with line ${startSeen.get(key)}`,
      });
    } else {
      startSeen.set(key, b._line);
    }
  }

  // --- Report ---
  console.log(`\nTeacher arg: ${args.teacher}`);
  console.log(
    `Parsed: ${students.length} students, ${packages.length} packages, ${bookings.length} bookings`,
  );

  if (issues.length > 0) {
    console.error(`\n✗ ${issues.length} issue(s) — nothing will be written:\n`);
    for (const i of issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(`  ${i.file}:${i.line}  ${i.message}`);
    }
    process.exit(1);
  }

  // Reconciliation: per-student balances + overbooking warnings (BUG-1: the
  // booking guard counts classes_used only, so scheduled-but-incomplete
  // bookings beyond remaining balance let a student overbook).
  console.log("\nReconciliation:");
  const scheduledByPkg = new Map<string, number>();
  const completedByPkg = new Map<string, number>();
  for (const b of bookings) {
    const m = b.status === "scheduled" ? scheduledByPkg : completedByPkg;
    m.set(b.package_ref, (m.get(b.package_ref) ?? 0) + 1);
  }
  let warnings = 0;
  for (const s of students) {
    const pkgs = packages.filter((p) => p.student_ref === s.student_ref);
    const label = s.email ? `${s.name} <${s.email}>` : `${s.name} (no email)`;
    console.log(`  ${label}`);
    for (const p of pkgs) {
      const remaining = p.classes_total - p.classes_used;
      const sched = scheduledByPkg.get(p.package_ref) ?? 0;
      const done = completedByPkg.get(p.package_ref) ?? 0;
      let note = "";
      if (sched > remaining) {
        note = `  ⚠ ${sched} scheduled > ${remaining} remaining (overbooking risk)`;
        warnings++;
      }
      console.log(
        `    ${p.package_ref} [${p.status}]: ${p.classes_used}/${p.classes_total} used, ${remaining} remaining · ${sched} scheduled, ${done} completed${note}`,
      );
    }
    if (pkgs.length === 0) console.log("    (no packages)");
  }
  if (warnings > 0) {
    console.log(`\n⚠ ${warnings} overbooking warning(s) — review before commit.`);
  }

  // --- Emit SQL mode: reuse all the computation above, but write the
  // idempotent upserts to <dir>/import.sql instead of touching Prisma. Used
  // when the target DB is only reachable via a SQL console / MCP. The SQL
  // mirrors the Prisma upserts below 1:1 (same ids, same Model B
  // classes_used, same tz-converted timestamps).
  if (args.emitSql) {
    const ns = args.teacher; // teacher UUID, used verbatim as the id namespace
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ns)) {
      console.error("\n✗ --emit-sql requires --teacher to be the teacher UUID");
      process.exit(1);
    }
    const q = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
    const ts = (d: Date) => `'${d.toISOString()}'::timestamptz`;
    const lines: string[] = ["BEGIN;"];

    for (const s of students) {
      const id = deterministicUuid(ns, `student:${s.student_ref}`);
      lines.push(
        `INSERT INTO students (id,name,email,phone_e164,timezone,locale,notification_prefs) VALUES (${q(id)},${q(s.name)},${q(s.email ?? null)},${q(s.phone ?? null)},${q(s.timezone ?? DEFAULT_TZ)},${q(s.locale ?? DEFAULT_LOCALE)},${q(JSON.stringify(IMPORTED_NOTIFICATION_PREFS))}::jsonb) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,phone_e164=EXCLUDED.phone_e164,timezone=EXCLUDED.timezone,locale=EXCLUDED.locale;`,
      );
      lines.push(
        `INSERT INTO teacher_students (teacher_id,student_id) VALUES (${q(ns)},${q(id)}) ON CONFLICT (teacher_id,student_id) DO NOTHING;`,
      );
    }
    for (const p of packages) {
      const id = deterministicUuid(ns, `package:${p.package_ref}`);
      const studentId = deterministicUuid(ns, `student:${p.student_ref}`);
      const tz = tzByStudent.get(p.student_ref) ?? DEFAULT_TZ;
      const classesUsed = p.classes_used + (scheduledByPkg.get(p.package_ref) ?? 0);
      const expires = p.expires_date ? ts(packageDate(p.expires_date, tz)) : "NULL";
      lines.push(
        `INSERT INTO packages (id,teacher_id,student_id,classes_total,classes_used,price_paid_minor_units,purchased_at,expires_at,status) VALUES (${q(id)},${q(ns)},${q(studentId)},${p.classes_total},${classesUsed},${p.price_paid_mxn},${ts(packageDate(p.purchased_date, tz))},${expires},'${p.status}'::"PackageStatus") ON CONFLICT (id) DO UPDATE SET teacher_id=EXCLUDED.teacher_id,student_id=EXCLUDED.student_id,classes_total=EXCLUDED.classes_total,classes_used=EXCLUDED.classes_used,price_paid_minor_units=EXCLUDED.price_paid_minor_units,purchased_at=EXCLUDED.purchased_at,expires_at=EXCLUDED.expires_at,status=EXCLUDED.status;`,
      );
    }
    for (const b of bookings) {
      const studentId = deterministicUuid(ns, `student:${b.student_ref}`);
      const packageId = deterministicUuid(ns, `package:${b.package_ref}`);
      const tz = tzByStudent.get(b.student_ref) ?? DEFAULT_TZ;
      const start = bookingStart(b.start_datetime, tz);
      const end = new Date(start.getTime() + b.duration_min * 60_000);
      const id = deterministicUuid(ns, `booking:${b.package_ref}:${b.start_datetime}`);
      const completed = b.status === "completed" ? ts(end) : "NULL";
      lines.push(
        `INSERT INTO bookings (id,package_id,teacher_id,student_id,scheduled_start,scheduled_end,status,completed_at) VALUES (${q(id)},${q(packageId)},${q(ns)},${q(studentId)},${ts(start)},${ts(end)},'${b.status}'::"BookingStatus",${completed}) ON CONFLICT (id) DO UPDATE SET package_id=EXCLUDED.package_id,teacher_id=EXCLUDED.teacher_id,student_id=EXCLUDED.student_id,scheduled_start=EXCLUDED.scheduled_start,scheduled_end=EXCLUDED.scheduled_end,status=EXCLUDED.status,completed_at=EXCLUDED.completed_at;`,
      );
    }
    lines.push("COMMIT;");
    const outPath = resolve(dir, "import.sql");
    writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
    console.error(
      `\nWrote SQL for ${students.length} students, ${packages.length} packages, ${bookings.length} bookings to ${outPath}`,
    );
    return;
  }

  // CSVs are valid. From here we need the DB — resolve the teacher.
  const prisma = new PrismaClient({ adapter: envAdapter() });
  const teacher = await prisma.teacher.findFirst({
    where: { OR: [{ bookingSlug: args.teacher }, { id: args.teacher }] },
    select: { id: true, name: true, bookingSlug: true },
  });
  if (!teacher) {
    console.error(`\n✗ teacher not found for '${args.teacher}'`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`\nTeacher: ${teacher.name} (${teacher.bookingSlug}) — ${teacher.id}`);

  if (!args.commit) {
    console.log("Dry run — nothing written. Re-run with --commit to apply.\n");
    await prisma.$disconnect();
    return;
  }

  // --- Commit (idempotent upserts, no events emitted) ---
  const ns = teacher.id;
  let wroteStudents = 0;
  let wrotePackages = 0;
  let wroteBookings = 0;

  await prisma.$transaction(async (tx) => {
    for (const s of students) {
      const id = deterministicUuid(ns, `student:${s.student_ref}`);
      const data = {
        name: s.name,
        email: s.email ?? null,
        phoneE164: s.phone ?? null,
        timezone: s.timezone ?? DEFAULT_TZ,
        locale: s.locale ?? DEFAULT_LOCALE,
      };
      await tx.student.upsert({
        where: { id },
        create: { id, ...data, notificationPrefs: IMPORTED_NOTIFICATION_PREFS },
        update: data,
      });
      await tx.teacherStudent.upsert({
        where: { teacherId_studentId: { teacherId: ns, studentId: id } },
        create: { teacherId: ns, studentId: id },
        update: {},
      });
      wroteStudents++;
    }

    for (const p of packages) {
      const id = deterministicUuid(ns, `package:${p.package_ref}`);
      const studentId = deterministicUuid(ns, `student:${p.student_ref}`);
      const tz = tzByStudent.get(p.student_ref) ?? DEFAULT_TZ;
      const data: Prisma.PackageUncheckedCreateInput = {
        id,
        teacherId: ns,
        studentId,
        classesTotal: p.classes_total,
        // Model B: classes_used = COMMITTED (consumed + reserved). The source
        // file's classes_used is consumed-only, so add the scheduled bookings
        // we're about to import or the package would be overbookable.
        classesUsed: p.classes_used + (scheduledByPkg.get(p.package_ref) ?? 0),
        pricePaidMinorUnits: p.price_paid_mxn,
        purchasedAt: packageDate(p.purchased_date, tz),
        expiresAt: p.expires_date ? packageDate(p.expires_date, tz) : null,
        status: p.status,
      };
      const { id: _omit, ...update } = data;
      await tx.package.upsert({ where: { id }, create: data, update });
      wrotePackages++;
    }

    for (const b of bookings) {
      const studentId = deterministicUuid(ns, `student:${b.student_ref}`);
      const packageId = deterministicUuid(ns, `package:${b.package_ref}`);
      const tz = tzByStudent.get(b.student_ref) ?? DEFAULT_TZ;
      const start = bookingStart(b.start_datetime, tz);
      const end = new Date(start.getTime() + b.duration_min * 60_000);
      const id = deterministicUuid(ns, `booking:${b.package_ref}:${b.start_datetime}`);
      const data: Prisma.BookingUncheckedCreateInput = {
        id,
        packageId,
        teacherId: ns,
        studentId,
        scheduledStart: start,
        scheduledEnd: end,
        status: b.status,
        completedAt: b.status === "completed" ? end : null,
      };
      const { id: _omit, ...update } = data;
      await tx.booking.upsert({ where: { id }, create: data, update });
      wroteBookings++;
    }
  });

  console.log(
    `\n✓ committed: ${wroteStudents} students, ${wrotePackages} packages, ${wroteBookings} bookings`,
  );
  console.log(
    "No notifications were sent. Verify balances + blocked slots before inviting students.\n",
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
