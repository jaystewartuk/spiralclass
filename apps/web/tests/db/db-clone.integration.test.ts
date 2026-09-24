import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_setup/test-db";

/**
 * The region-move clone, run for real against the migrated test database.
 *
 * WHY THIS EXISTS. `infra/database/scripts/db-clone-to-region.sh` is how
 * production moves region (D-49), and until 2026-09-23 it had never been run
 * against this schema. Its first rehearsal — Neon `us-east-2` into `us-east-1`
 * — failed twice: once on macOS bash 3.2 (guarded by
 * `tests/config/shell-empty-arrays.test.ts`), then because `pg_dump -n public`
 * does not carry extensions, so btree_gist never arrived and both bookings
 * exclusion constraints failed to restore. The row checksums would have passed
 * that clone: every row was there. Only the constraints that refuse a double
 * booking were missing.
 *
 * So this clones the real migrated schema — every extension, exclusion
 * constraint, trigger and function the invariants migration creates — and
 * asserts the copy still enforces them. It then removes one from the copy and
 * asserts `db-verify-clone.sh` refuses it, which is the check a cutover rests
 * on.
 *
 * The scripts run INSIDE the test container, with its own `pg_dump`/`psql`, so
 * the client always matches the server and neither the laptop nor the runner
 * needs a libpq install — the same choice `scripts/ci/integration.sh` makes.
 */

const CONTAINER = "spiralclass-test-db";
const SCRIPTS = resolve(__dirname, "../../../../infra/database/scripts");
const TAG = randomBytes(4).toString("hex");
const REMOTE_DIR = `/tmp/db-clone-${TAG}`;
const TARGET_DB = `clone_target_${TAG}`;

function insideContainer(dbName: string): string {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  return `postgresql://${u.username}:${u.password}@localhost:5432/${dbName}`;
}

function run(script: string, ...args: string[]) {
  const r = spawnSync("docker", ["exec", CONTAINER, "bash", `${REMOTE_DIR}/${script}`, ...args], {
    encoding: "utf8",
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describeIntegration("the region-move clone keeps what the schema enforces", () => {
  const sourceDb = () => new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1);
  let admin: Client;
  let target: Client;

  beforeAll(async () => {
    execFileSync("docker", ["cp", SCRIPTS, `${CONTAINER}:${REMOTE_DIR}`]);
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TARGET_DB}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${TARGET_DB}`;
    target = new Client({ connectionString: u.toString() });
    await target.connect();
  });

  afterAll(async () => {
    await target?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)`);
    await admin?.end();
    spawnSync("docker", ["exec", CONTAINER, "rm", "-rf", REMOTE_DIR]);
  });

  it("clones the migrated schema, extensions and exclusion constraints included", async () => {
    const r = run(
      "db-clone-to-region.sh",
      "--yes",
      insideContainer(sourceDb()),
      insideContainer(TARGET_DB),
    );
    expect(r.output).toContain("clone verified");
    expect(r.status).toBe(0);

    const ext = await target.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(ext.rowCount).toBe(1);
    const excl = await target.query(
      `SELECT conname FROM pg_constraint WHERE contype = 'x' ORDER BY conname`,
    );
    expect(excl.rows.map((row) => row.conname)).toEqual([
      "bookings_no_overlap_active",
      "bookings_no_overlap_buffered",
    ]);
  }, 60_000);

  it("refuses a copy that has every row but has lost a constraint", async () => {
    await target.query(`ALTER TABLE bookings DROP CONSTRAINT bookings_no_overlap_active`);

    const r = run("db-verify-clone.sh", insideContainer(sourceDb()), insideContainer(TARGET_DB));
    expect(r.output).toMatch(/source only: constraint bookings bookings_no_overlap_active EXCLUDE/);
    expect(r.status).toBe(1);
  }, 60_000);
});
