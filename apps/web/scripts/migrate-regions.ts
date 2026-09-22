// D-49 layer 2 runner: `prisma migrate deploy` against every region in turn.
//
// Replaces a bare `prisma migrate deploy` in the build + the manual migrate:*
// scripts. With no MIGRATE_REGIONS set it runs exactly once against the ambient
// DATABASE_URL/DIRECT_URL (unchanged behavior); with MIGRATE_REGIONS set it
// loops the region list so the schema lands identically everywhere.
//
// Pure logic (parsing, validation, per-region env) lives in
// src/lib/migrations/regions.ts and is unit-tested; this file is just the shell
// boundary. Connection strings are NEVER logged — only region names.

import { spawnSync } from "node:child_process";
import { envForTarget, resolveMigrationTargets } from "@/lib/migrations/regions";

// Pass through any extra args (e.g. `--schema=...`); default is `migrate deploy`.
const passthrough = process.argv.slice(2);
const prismaArgs = passthrough.length > 0 ? passthrough : ["migrate", "deploy"];

const targets = resolveMigrationTargets();
const label = targets.map((t) => t.name).join(", ");
console.log(`prisma ${prismaArgs.join(" ")} → ${targets.length} region(s): ${label}`);

for (const target of targets) {
  console.log(`\n== region: ${target.name} ==`);
  const result = spawnSync("prisma", prismaArgs, {
    stdio: "inherit",
    // spread of process.env keeps PATH (so the node_modules/.bin prisma
    // resolves) and only swaps the per-region connection strings.
    env: envForTarget(target) as NodeJS.ProcessEnv,
  });

  if (result.error) {
    console.error(`Failed to spawn prisma for region "${target.name}": ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `prisma ${prismaArgs.join(" ")} FAILED for region "${target.name}" (exit ${result.status}). ` +
        `Stopping — later regions were NOT migrated. Fix and re-run; migrate deploy is idempotent, ` +
        `so already-migrated regions are safely re-applied.`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${targets.length} region(s) migrated.`);
