import { describe, expect, it, vi } from "vitest";
import {
  buildTeacherExport,
  buildStudentExport,
  buildStudentIdentityExport,
} from "@/lib/account-deletion/export-data";

// MED-6: self-serve data export. Pin the envelope shape, confirm the
// builder selects via Prisma (so it can't accidentally return secret
// columns the schema doesn't expose), and that a missing subject → null.

function fakeDb(row: unknown) {
  return {
    teacher: { findUnique: vi.fn(async () => row) },
    student: { findUnique: vi.fn(async () => row) },
  } as never;
}

describe("buildTeacherExport", () => {
  it("wraps the teacher row in an envelope with metadata", async () => {
    const teacher = { id: "t1", email: "a@b.com", name: "Mira", packages: [], bookings: [] };
    const env = await buildTeacherExport(fakeDb(teacher), "t1");
    expect(env).not.toBeNull();
    expect(env!.subjectType).toBe("teacher");
    expect(env!.subjectId).toBe("t1");
    expect(typeof env!.exportedAt).toBe("string");
    expect(env!.data).toEqual(teacher);
  });

  it("returns null when the teacher doesn't exist", async () => {
    const env = await buildTeacherExport(fakeDb(null), "missing");
    expect(env).toBeNull();
  });

  it("never requests a secret column (select stays allow-list)", async () => {
    const db = fakeDb({ id: "t1" });
    await buildTeacherExport(db, "t1");
    const select = (db as any).teacher.findUnique.mock.calls[0][0].select;
    // Whatever we select, it must not include anything secret-shaped.
    const keys = JSON.stringify(select);
    expect(keys).not.toMatch(/secret|token|password|webhook/i);
    // And it must be an explicit allow-list (select present), not a full row.
    expect(select).toBeTruthy();
  });
});

describe("buildStudentExport", () => {
  it("wraps the student row in an envelope", async () => {
    const student = { id: "s1", email: "s@b.com", name: "Sol", packages: [], bookings: [] };
    const env = await buildStudentExport(fakeDb(student), "s1");
    expect(env!.subjectType).toBe("student");
    expect(env!.subjectId).toBe("s1");
    // The row as read, with the consent date's absence spelled out (#155).
    expect(env!.data).toEqual({ ...student, emailOptInAt: "unknown" });
  });

  it("returns null when the student doesn't exist", async () => {
    const env = await buildStudentExport(fakeDb(null), "missing");
    expect(env).toBeNull();
  });
});

// #155: the export is where a student sees her consent record. A consent with
// a bare null beside it reads as missing data; a row whose opt-in changed
// before the date was ever recorded says so in words.
describe("the email consent date in a student export", () => {
  it("shows the date her opt-in last changed", async () => {
    const at = new Date("2026-11-16T10:00:00Z");
    const env = await buildStudentExport(
      fakeDb({ id: "s1", emailOptIn: false, emailOptInAt: at }),
      "s1",
    );
    expect(env!.data).toMatchObject({ emailOptIn: false, emailOptInAt: at });
  });

  it('says "unknown" when no date was ever recorded', async () => {
    const env = await buildStudentExport(
      fakeDb({ id: "s1", emailOptIn: true, emailOptInAt: null }),
      "s1",
    );
    expect(env!.data).toMatchObject({ emailOptIn: true, emailOptInAt: "unknown" });
  });

  it("carries the date through the identity-wide export", async () => {
    const env = await buildStudentIdentityExport(
      fakeDb({ id: "s1", emailOptIn: true, emailOptInAt: null }),
      ["s1"],
    );
    expect(env!.data).toMatchObject({ emailOptInAt: "unknown" });
  });

  it("still selects the date column", async () => {
    const db = fakeDb({ id: "s1" });
    await buildStudentExport(db, "s1");
    const select = (db as any).student.findUnique.mock.calls[0][0].select;
    expect(select.emailOptInAt).toBe(true);
  });
});
