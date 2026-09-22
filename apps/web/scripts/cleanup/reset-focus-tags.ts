// Focus-tag reset — deletes a teacher's (or EVERY teacher's) focus tags AND
// focus-tag categories so they re-seed from the current packs
// (@/lib/focus-packs) on next read. Focus tags self-heal: getTeacherFocusTags /
// getTeacherFocusCategories seed the language pack + builtin categories the
// first time a teacher has zero rows, so "delete all tag data" IS the reseed —
// the next time the compose picker renders, the fresh optimum pack is what a
// teacher sees.
//
// Use case: after curating the seed packs, wipe the already-seeded rows so
// existing teachers pick up the new set (a pack only ever seeds a teacher who
// has NONE, so without this reset they'd keep their stale first-seed forever).
//
// WARNING — this is destructive and NOT reversible. It also removes any tags a
// teacher renamed or added by hand and any custom categories: everything in
// focus_tags / focus_tag_categories for the targeted teacher(s) goes, then the
// pack reseeds the defaults only. Take a DB snapshot before --commit.
//
// FK order: library_material_focus_tags.focus_tag_id is ON DELETE CASCADE, so
// deleting focus_tags auto-removes those join rows. focus_tags.category_id is
// ON DELETE RESTRICT, so focus_tags MUST be deleted before focus_tag_categories.
//
// Usage:
//   pnpm cleanup:focus-tags                          # dry run, ALL teachers (counts only)
//   pnpm cleanup:focus-tags --teacher <slug-or-id>   # dry run, one teacher
//   pnpm cleanup:focus-tags --commit                 # delete (all teachers)
//   pnpm cleanup:focus-tags --teacher <id> --commit  # delete (one teacher)
//   pnpm cleanup:focus-tags --emit-sql               # write DELETEs to a .sql file

import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { envAdapter } from "@/lib/db-pool";

interface Args {
  // Omitted = every teacher.
  teacher?: string;
  commit: boolean;
  emitSql: boolean;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    teacher: get("--teacher"),
    commit: argv.includes("--commit"),
    emitSql: argv.includes("--emit-sql"),
    out: get("--out") ?? "reset-focus-tags.sql",
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One transaction, children before parents (see FK note in the header). When
// scoped to a teacher, the category delete is scoped too; with no teacher the
// whole table is cleared.
function buildSql(teacherId?: string): string {
  const scope = teacherId ? ` WHERE teacher_id = '${teacherId}'` : "";
  return (
    [
      "BEGIN;",
      `DELETE FROM focus_tags${scope};`,
      `DELETE FROM focus_tag_categories${scope};`,
      "COMMIT;",
    ].join("\n") + "\n"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.emitSql) {
    if (args.teacher && !UUID_RE.test(args.teacher)) {
      console.error(
        "\n✗ --emit-sql requires --teacher to be the teacher UUID (or omit it for all)",
      );
      process.exit(1);
    }
    const outPath = resolve(process.cwd(), args.out);
    writeFileSync(outPath, buildSql(args.teacher), "utf8");
    console.error(
      `\nWrote focus-tag reset SQL${args.teacher ? ` for teacher ${args.teacher}` : " (all teachers)"} to ${outPath}`,
    );
    console.error("Review it, then run it against the target DB inside a transaction.\n");
    return;
  }

  const prisma = new PrismaClient({ adapter: envAdapter() });

  // Resolve the teacher filter once; reuse for counts and the delete.
  let teacherId: string | undefined;
  if (args.teacher) {
    const teacher = await prisma.teacher.findFirst({
      where: { OR: [{ bookingSlug: args.teacher }, { id: args.teacher }] },
      select: { id: true, name: true, bookingSlug: true },
    });
    if (!teacher) {
      console.error(`\n✗ teacher not found for '${args.teacher}'`);
      await prisma.$disconnect();
      process.exit(1);
    }
    teacherId = teacher.id;
    console.log(`\nTeacher: ${teacher.name} (${teacher.bookingSlug}) — ${teacher.id}`);
  } else {
    console.log("\nScope: ALL teachers");
  }

  const where = teacherId ? { teacherId } : {};
  const [tags, categories] = await Promise.all([
    prisma.focusTag.count({ where }),
    prisma.focusTagCategory.count({ where }),
  ]);

  console.log("\nIn scope for deletion (rows re-seed from the packs on next read):");
  console.log(`  focus tags:        ${tags}`);
  console.log(`  focus categories:  ${categories}`);

  if (tags + categories === 0) {
    console.log("\nNothing to delete — no focus-tag data in scope.\n");
    await prisma.$disconnect();
    return;
  }

  if (!args.commit) {
    console.log("\nDry run — nothing deleted. Re-run with --commit to apply.\n");
    await prisma.$disconnect();
    return;
  }

  // Commit. focus_tags before focus_tag_categories (RESTRICT FK); the
  // library_material_focus_tags join rows go by cascade when their tag does.
  const result = await prisma.$transaction(async (tx) => {
    const delTags = await tx.focusTag.deleteMany({ where });
    const delCategories = await tx.focusTagCategory.deleteMany({ where });
    return { delTags, delCategories };
  });

  console.log(
    `\n✓ deleted: ${result.delTags.count} focus tags, ${result.delCategories.count} categories ` +
      `(+ their library-material tag links by cascade).`,
  );
  console.log(
    "They will re-seed from the current packs the next time each teacher's picker loads.\n",
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
