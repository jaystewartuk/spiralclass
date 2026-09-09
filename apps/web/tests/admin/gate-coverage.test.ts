import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Every /admin page and every admin-* server action must call the admin gate.
// The gate (requireAdmin) is the REAL authorization boundary: middleware only
// checks auth presence (src/middleware.ts), the admin layout is a shell with no
// MFA check, and server actions are independently POST-able. A new admin route
// that forgets the gate would ship ungated — this test fails the build instead.
// docs/decisions/D-25.md.

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "..");
const ADMIN_PAGES_DIR = join(WEB, "src", "app", "admin");
const ACTIONS_DIR = join(WEB, "src", "app", "actions");

// The only admin surfaces allowed to use resolveAdminActor() (no MFA) instead
// of requireAdmin(): the step-up page itself, its enrolment actions, and the
// layout shell. Gating these on MFA would make step-up unreachable.
const MFA_EXEMPT = new Set([
  join(ADMIN_PAGES_DIR, "security", "page.tsx"),
  join(ADMIN_PAGES_DIR, "layout.tsx"),
  join(ACTIONS_DIR, "admin-mfa.ts"),
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const referencesStrictGate = (src: string) => /requireAdmin\s*\(|requireSuperuser\s*\(/.test(src);
const referencesAnyGate = (src: string) =>
  referencesStrictGate(src) || /resolveAdminActor\s*\(/.test(src);

describe("admin gate coverage", () => {
  const pageFiles = walk(ADMIN_PAGES_DIR).filter((p) => p.endsWith("page.tsx"));
  const actionFiles = walk(ACTIONS_DIR).filter((p) => /admin-[\w-]+\.ts$/.test(p));

  it("discovers a realistic number of admin surfaces", () => {
    expect(pageFiles.length).toBeGreaterThan(5);
    expect(actionFiles.length).toBeGreaterThan(3);
  });

  for (const file of [...pageFiles, ...actionFiles]) {
    const rel = file.slice(WEB.length + 1);
    it(`gates ${rel}`, () => {
      const src = readFileSync(file, "utf8");
      if (MFA_EXEMPT.has(file)) {
        expect(referencesAnyGate(src), `${rel} must call resolveAdminActor or requireAdmin`).toBe(
          true,
        );
      } else {
        expect(
          referencesStrictGate(src),
          `${rel} must call requireAdmin/requireSuperuser (the MFA-enforcing gate)`,
        ).toBe(true);
      }
    });
  }
});
