import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// D-204: every path that creates a Student row stamps the shared default
// prefs, so no new student can quietly start with a category the teacher's
// own sends depend on switched off. A creation site that writes its own
// literal map is how class_materials ended up off for every new student. The
// only deliberate exception is the roster CSV import (scripts/import), which
// starts silent and is launched by the teacher; it lives outside src/.

const SRC = resolve(REPO_ROOT, "apps/web/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

describe("every student creation path uses the shared default prefs (D-204)", () => {
  const creators = sourceFiles(SRC).filter((f) =>
    /\b(?:tx|prisma)\.student\.create\(/.test(readFileSync(f, "utf8")),
  );

  it("finds the known creation sites", () => {
    expect(creators.map((f) => relative(SRC, f)).sort()).toEqual([
      "app/actions/teacher-students.ts",
      "lib/invitations/manage.ts",
      "lib/students/find-or-create.ts",
    ]);
  });

  for (const file of creators) {
    it(`${relative(SRC, file)} stamps defaultNewStudentNotificationPrefs()`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("notificationPrefs: defaultNewStudentNotificationPrefs()");
      expect(src).not.toMatch(/notificationPrefs:\s*\{/);
    });
  }
});
