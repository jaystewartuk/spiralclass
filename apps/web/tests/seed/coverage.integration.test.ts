import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";

import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { seedAll, type SeedDeps } from "../../scripts/seed";

/**
 * Every model in the schema has at least one row after the seed runs.
 *
 * WHY THIS EXISTS. "The seed fills everything" is the kind of claim that is
 * true the day it is written and quietly false a month later, when somebody
 * adds a model and nothing asks them to seed it. Seventeen of eighty-two models
 * had fixtures before `seed-fixtures.ts`; the other sixty-five arrived in one
 * change, and without this the next model would start the drift again.
 *
 * The failure it prevents is not a red test. It is a surface rendering its
 * EMPTY STATE on a fresh clone — which nobody notices, because an empty state
 * is a legitimate thing for a page to show.
 *
 * ⚠️ IT READS THE SCHEMA, NOT A LIST. A hand-written list of models is the same
 * drift one level up: it would need an entry for each new model, and whoever
 * forgot to seed one will forget to list it too. Parsing `schema.prisma` is
 * what makes adding a model the thing that fails.
 *
 * ⚠️ AND IT RUNS THE REAL `seedAll`, not a reconstruction. Two earlier attempts
 * at the gap analysis behind `seed-fixtures.ts` were wrong — one missed models
 * seeded through a helper (`ensureTeacherLevels`), the other missed models
 * seeded through a nested relation field (`payoutInstruments: { create }`) —
 * and both produced a seed that crashed on a unique constraint. Static reading
 * of the seed is exactly what this must not depend on.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT is row counts. A fixture growing from
 * three rows to four is not a regression, and a test that said so would be
 * edited on every unrelated change until somebody deleted it.
 */

const SCHEMA = join(process.cwd(), "prisma", "schema.prisma");

/** Every `model X` in the schema — the one list that cannot drift. */
function schemaModels(): string[] {
  return [...readFileSync(SCHEMA, "utf8").matchAll(/^model (\w+) \{/gm)].map((m) => m[1]!);
}

/**
 * Deps that do nothing but hand back an id.
 *
 * `SeedDeps` exists so the seed can be driven without R2, and this is what that
 * seam is for: the uploads report failure, the seed carries on, and the row
 * that would have referenced an object still gets written. It is the same path
 * a developer with no credentials takes, which is the point — if the seed only
 * filled the schema on a machine with vendor keys, this test would be asserting
 * something no fresh clone ever sees.
 */
function headlessDeps(prisma: ReturnType<typeof getTestPrisma>): SeedDeps {
  const ensureUser = async (email: string, name: string): Promise<string> => {
    const existing = await prisma.user.findFirst({ where: { email }, select: { id: true } });
    if (existing) return existing.id;
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1::uuid, $2, $3, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
      id,
      name,
      email,
    );
    return id;
  };

  const noUpload = async () => ({ ok: false, error: "headless: no object storage in this test" });

  return {
    provisionTeacherAuthUser: (email, name) => ensureUser(email, name),
    ensureStudentAuthUser: async (email) => {
      await ensureUser(email, email.split("@")[0] ?? "Student");
    },
    uploadMaterial: noUpload,
    uploadTeacherPhoto: noUpload,
    uploadTeacherVideo: noUpload,
  };
}

describeIntegration("seed coverage: every model has fixtures", () => {
  const models = schemaModels();
  const empty: string[] = [];

  beforeAll(async () => {
    const prisma = getTestPrisma();
    await truncateAll();
    await seedAll(prisma, headlessDeps(prisma), { bulkTeachers: 0, studentsPerBulkTeacher: 0 });

    for (const model of models) {
      const delegate = (prisma as unknown as Record<string, { count?: () => Promise<number> }>)[
        model[0]!.toLowerCase() + model.slice(1)
      ];
      if (!delegate?.count) continue;
      if ((await delegate.count()) === 0) empty.push(model);
    }
  }, 180_000);

  it("reads a plausible number of models out of the schema", () => {
    // Guards the guard: a regex matching nothing would report every model as
    // covered, having counted none of them.
    expect(models.length).toBeGreaterThan(50);
  });

  it("leaves no model empty", () => {
    expect(
      empty,
      "These models have no seed fixtures, so every surface that reads one renders " +
        "its empty state on a fresh clone. Add them to " +
        "apps/web/scripts/seed-fixtures.ts.\n  " +
        empty.join("\n  "),
    ).toEqual([]);
  });
});
