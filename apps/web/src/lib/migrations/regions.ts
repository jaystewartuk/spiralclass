// D-49 layer 2 (schema): keep the DB schema identical across every region by
// running `prisma migrate deploy` against a *list* of regional connection
// strings instead of a single one. This module is the pure, testable core; the
// runner that actually shells out to prisma is `scripts/migrate-regions.ts`.
//
// Vendor-neutral by construction (D-49): a "region" is just a Postgres
// connection string. Nothing here knows or cares whether it points at Supabase,
// Neon, RDS, or self-hosted Postgres — that is exactly the portability the
// three-layer model buys.

/** One Postgres a migration must be applied to. */
export type MigrationTarget = {
  /** Human label for logs/diffs (e.g. "us-east-1"). Never a secret. */
  name: string;
  /** Pooled app URL (Prisma `url`). */
  databaseUrl: string;
  /** Direct URL (Prisma `directUrl`) — what `migrate deploy` actually uses. */
  directUrl: string;
};

/** Env var holding the multi-region list (JSON array of MigrationTarget-ish). */
export const MIGRATE_REGIONS_ENV = "MIGRATE_REGIONS";

type EnvLike = Record<string, string | undefined>;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Resolve the ordered list of regions to run `prisma migrate deploy` against.
 *
 * - **Multi-region:** set `MIGRATE_REGIONS` to a JSON array of
 *   `{ name, databaseUrl, directUrl? }`. `directUrl` defaults to `databaseUrl`.
 *   The array order is the deploy order.
 * - **Single-region (today's default):** leave `MIGRATE_REGIONS` unset (or
 *   blank) and the ambient `DATABASE_URL` / `DIRECT_URL` become one target named
 *   "default" — byte-for-byte the current behavior. So landing this is a
 *   behavioral no-op until a second region actually exists (D-49 sequencing:
 *   the mechanism ships before the trigger, dormant until needed).
 *
 * Throws on any malformed multi-region config rather than silently skipping a
 * region — a half-migrated fleet is the failure mode this whole layer exists to
 * prevent.
 */
export function resolveMigrationTargets(env: EnvLike = process.env): MigrationTarget[] {
  const raw = env[MIGRATE_REGIONS_ENV];

  // Unset or blank → single-region fallback (current production behavior).
  if (!isNonEmptyString(raw)) {
    const databaseUrl = env.DATABASE_URL;
    if (!isNonEmptyString(databaseUrl)) {
      throw new Error(
        `No migration target: ${MIGRATE_REGIONS_ENV} is unset and DATABASE_URL is empty. ` +
          `Set DATABASE_URL (single region) or ${MIGRATE_REGIONS_ENV} (multi-region).`,
      );
    }
    const directUrl = isNonEmptyString(env.DIRECT_URL) ? env.DIRECT_URL : databaseUrl;
    return [{ name: "default", databaseUrl, directUrl }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${MIGRATE_REGIONS_ENV} is not valid JSON: ${(err as Error).message}. ` +
        `Expected a JSON array of { name, databaseUrl, directUrl? }.`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${MIGRATE_REGIONS_ENV} must be a non-empty JSON array of { name, databaseUrl, directUrl? }.`,
    );
  }

  const seen = new Set<string>();
  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${MIGRATE_REGIONS_ENV}[${i}] must be an object, got ${typeof entry}.`);
    }
    const { name, databaseUrl, directUrl } = entry as Record<string, unknown>;
    if (!isNonEmptyString(name)) {
      throw new Error(
        `${MIGRATE_REGIONS_ENV}[${i}].name is required and must be a non-empty string.`,
      );
    }
    if (!isNonEmptyString(databaseUrl)) {
      throw new Error(
        `${MIGRATE_REGIONS_ENV}[${i}] (${name}).databaseUrl is required and must be a non-empty string.`,
      );
    }
    if (directUrl !== undefined && !isNonEmptyString(directUrl)) {
      throw new Error(
        `${MIGRATE_REGIONS_ENV}[${i}] (${name}).directUrl, if present, must be a non-empty string.`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `${MIGRATE_REGIONS_ENV} has a duplicate region name "${name}"; names must be unique.`,
      );
    }
    seen.add(name);
    return {
      name,
      databaseUrl,
      directUrl: isNonEmptyString(directUrl) ? directUrl : databaseUrl,
    };
  });
}

/**
 * Build the child-process env for one target: the base env with this region's
 * `DATABASE_URL` / `DIRECT_URL` swapped in. Prisma reads those two, so pointing
 * them at each region in turn is all it takes to migrate the whole fleet.
 */
export function envForTarget(target: MigrationTarget, base: EnvLike = process.env): EnvLike {
  return { ...base, DATABASE_URL: target.databaseUrl, DIRECT_URL: target.directUrl };
}
