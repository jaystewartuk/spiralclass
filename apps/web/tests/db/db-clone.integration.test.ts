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
 *
 * AND NO PASSWORD ON A COMMAND LINE. A process's arguments are visible to
 * every user on the machine; its environment only to its owner. So every
 * `psql`/`pg_dump`/`pg_restore` the scripts start runs through a shim that
 * records its argv and its parent's — the calling script's own, which is how a
 * URL passed script-to-script shows — and the run connects as a role whose
 * password appears nowhere else.
 */

const CONTAINER = "spiralclass-test-db";
const SCRIPTS = resolve(__dirname, "../../../../infra/database/scripts");
const TAG = randomBytes(4).toString("hex");
const REMOTE_DIR = `/tmp/db-clone-${TAG}`;
const SHIM_DIR = `${REMOTE_DIR}/shim`;
const ARGV_LOG = `${REMOTE_DIR}/argv.log`;
const TARGET_DB = `clone_target_${TAG}`;
const ROLE = `clone_probe_${TAG}`;
// Distinctive, so finding it in the log can only mean a leak.
const PASSWORD = `pw${randomBytes(12).toString("hex")}`;

// Records its own argv and its parent's, then execs the real client. One
// printf per record: pg_dump and pg_restore run at once in a pipeline, and
// appends made in pieces interleave.
const SHIM = `#!/bin/bash
rec="$(basename "$0")$(printf ' %s' "$@")"$'\\n'"parent: $(tr '\\0' ' ' < /proc/$PPID/cmdline)"
printf '%s\\n' "$rec" >> ${ARGV_LOG}
PATH="\${PATH#${SHIM_DIR}:}" exec "$(basename "$0")" "$@"
`;

function url(dbName: string): string {
  return `postgresql://${ROLE}:${PASSWORD}@localhost:5432/${dbName}`;
}

/**
 * Runs a script in the container with the shims first on PATH. URLs go in the
 * environment: `docker exec -e NAME` with no value copies it from this
 * process, so the harness does not put the password on a command line either.
 */
function run(script: string, env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(
    "docker",
    [
      "exec",
      ...Object.keys(env).flatMap((name) => ["-e", name]),
      CONTAINER,
      "bash",
      "-c",
      `PATH=${SHIM_DIR}:$PATH exec bash ${REMOTE_DIR}/${script} "$@"`,
      "bash",
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describeIntegration("the region-move clone keeps what the schema enforces", () => {
  const sourceDb = () => new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1);
  const both = () => ({
    SOURCE_DATABASE_URL: url(sourceDb()),
    TARGET_DATABASE_URL: url(TARGET_DB),
  });
  let admin: Client;
  let target: Client;

  beforeAll(async () => {
    execFileSync("docker", ["cp", SCRIPTS, `${CONTAINER}:${REMOTE_DIR}`]);
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        CONTAINER,
        "bash",
        "-c",
        `mkdir -p ${SHIM_DIR} && cat > ${SHIM_DIR}/shim && chmod +x ${SHIM_DIR}/shim && ` +
          `for t in psql pg_dump pg_restore; do ln -s shim ${SHIM_DIR}/$t; done`,
      ],
      { input: SHIM },
    );
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE ROLE ${ROLE} LOGIN SUPERUSER PASSWORD '${PASSWORD}'`);
    await admin.query(`CREATE DATABASE ${TARGET_DB}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${TARGET_DB}`;
    target = new Client({ connectionString: u.toString() });
    await target.connect();
  });

  afterAll(async () => {
    await target?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)`);
    await admin?.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await admin?.end();
    spawnSync("docker", ["exec", CONTAINER, "rm", "-rf", REMOTE_DIR]);
  });

  it("clones the migrated schema, extensions and exclusion constraints included", async () => {
    const r = run("db-clone-to-region.sh", both(), "--yes");
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

    const r = run("db-verify-clone.sh", both());
    expect(r.output).toMatch(/source only: constraint bookings bookings_no_overlap_active EXCLUDE/);
    expect(r.status).toBe(1);
  }, 60_000);

  it("reads replication state with the URLs in the environment", () => {
    const r = run("db-logical-replication.sh", both(), "status");
    expect(r.output).toContain("subscription state");
    expect(r.status).toBe(0);
  }, 60_000);

  it("put no password on any command line it started", () => {
    const log = execFileSync("docker", ["exec", CONTAINER, "cat", ARGV_LOG], {
      encoding: "utf8",
    });
    // The shims saw real work — an empty log would pass the next line vacuously.
    for (const client of ["psql", "pg_dump", "pg_restore"]) {
      expect(log).toMatch(new RegExp(`^${client} `, "m"));
    }
    expect(log).toContain(`${ROLE}@localhost`);
    expect(log).not.toContain(PASSWORD);
  });

  it.each([
    ["db-clone-to-region.sh", ["--yes"]],
    ["db-verify-clone.sh", []],
    ["db-rehearse-clone.sh", []],
  ])("%s refuses a URL with a password as an argument", (script, extra) => {
    const r = run(script, {}, ...extra, url(sourceDb()), url(TARGET_DB));
    expect(r.output).toContain("Pass it in the environment instead");
    expect(r.status).toBe(1);
  });

  it("db-logical-replication.sh refuses a URL as an argument", () => {
    const r = run("db-logical-replication.sh", {}, "status", url(TARGET_DB));
    expect(r.output).toContain("come from SOURCE_DATABASE_URL / TARGET_DATABASE_URL");
    expect(r.status).toBe(1);
  });
});
