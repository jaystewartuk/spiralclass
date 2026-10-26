import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

/**
 * The D-204 backfill flips `class_materials` for exactly one kind of row: the
 * old new-student default, on a student who has never signed in. Every other
 * shape must come out of it exactly as it went in, because a stored `false` is
 * indistinguishable from a student's own opt-out and overriding one is the
 * failure this exists to avoid.
 */
const MIGRATION = resolve(
  process.cwd(),
  "prisma",
  "migrations",
  "20261025230000_backfill_untouched_class_materials_pref",
  "migration.sql",
);

const OLD_DEFAULT = {
  class_reminders: true,
  booking_updates: true,
  messages: true,
  class_materials: false,
  expiry_reminders: false,
};

const ALL_OFF = {
  class_reminders: false,
  booking_updates: false,
  messages: false,
  class_materials: false,
  expiry_reminders: false,
};

describeIntegration("backfill of the old class_materials default (D-204)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function seed(
    name: string,
    notificationPrefs: Prisma.InputJsonValue | typeof Prisma.DbNull,
    signedIn = false,
  ) {
    const prisma = getTestPrisma();
    const email = `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`;
    // `students.auth_user_id` is a foreign key to the auth user, so a signed-in
    // student needs a real one.
    const user = signedIn ? await prisma.user.create({ data: { name, email } }) : null;
    return prisma.student.create({
      data: { name, email, notificationPrefs, ...(user ? { authUserId: user.id } : {}) },
    });
  }

  async function prefsOf(id: string) {
    const row = await getTestPrisma().student.findUniqueOrThrow({
      where: { id },
      select: { notificationPrefs: true },
    });
    return row.notificationPrefs;
  }

  async function run() {
    await getTestPrisma().$executeRawUnsafe(readFileSync(MIGRATION, "utf8"));
  }

  it("flips only class_materials, only on the untouched old default of a never-signed-in student", async () => {
    const untouched = await seed("Untouched Default", OLD_DEFAULT);
    const signedIn = await seed("Signed In", OLD_DEFAULT, true);
    const chosenOff = await seed("Chose Off", { ...OLD_DEFAULT, messages: false });
    const extraKey = await seed("Extra Key", { ...OLD_DEFAULT, channelPrefs: { push: false } });
    const allOff = await seed("Roster Import", ALL_OFF);
    const alreadyOn = await seed("Already On", { ...OLD_DEFAULT, class_materials: true });
    const nullPrefs = await seed("Null Prefs", Prisma.DbNull);

    await run();

    expect(await prefsOf(untouched.id)).toEqual({ ...OLD_DEFAULT, class_materials: true });
    expect(await prefsOf(signedIn.id)).toEqual(OLD_DEFAULT);
    expect(await prefsOf(chosenOff.id)).toEqual({ ...OLD_DEFAULT, messages: false });
    expect(await prefsOf(extraKey.id)).toEqual({ ...OLD_DEFAULT, channelPrefs: { push: false } });
    expect(await prefsOf(allOff.id)).toEqual(ALL_OFF);
    expect(await prefsOf(alreadyOn.id)).toEqual({ ...OLD_DEFAULT, class_materials: true });
    expect(await prefsOf(nullPrefs.id)).toBeNull();
  });

  it("is idempotent", async () => {
    const student = await seed("Run Twice", OLD_DEFAULT);
    await run();
    await run();
    expect(await prefsOf(student.id)).toEqual({ ...OLD_DEFAULT, class_materials: true });
  });
});
