import { describe, expect, it } from "vitest";
import {
  MIGRATE_REGIONS_ENV,
  envForTarget,
  resolveMigrationTargets,
  type MigrationTarget,
} from "@/lib/migrations/regions";

const DB = "postgresql://u:p@pooler:6543/db?pgbouncer=true";
const DIRECT = "postgresql://u:p@direct:5432/db";

describe("resolveMigrationTargets — single-region fallback", () => {
  it("uses DATABASE_URL as one 'default' target when MIGRATE_REGIONS is unset", () => {
    expect(resolveMigrationTargets({ DATABASE_URL: DB })).toEqual([
      { name: "default", databaseUrl: DB, directUrl: DB },
    ]);
  });

  it("prefers DIRECT_URL for directUrl when present", () => {
    expect(resolveMigrationTargets({ DATABASE_URL: DB, DIRECT_URL: DIRECT })).toEqual([
      { name: "default", databaseUrl: DB, directUrl: DIRECT },
    ]);
  });

  it("treats a blank/whitespace MIGRATE_REGIONS as unset (falls back)", () => {
    const out = resolveMigrationTargets({ [MIGRATE_REGIONS_ENV]: "   ", DATABASE_URL: DB });
    expect(out).toEqual([{ name: "default", databaseUrl: DB, directUrl: DB }]);
  });

  it("throws when neither MIGRATE_REGIONS nor DATABASE_URL is set", () => {
    expect(() => resolveMigrationTargets({})).toThrow(/DATABASE_URL is empty/);
  });
});

describe("resolveMigrationTargets — multi-region", () => {
  it("returns targets in array order, defaulting directUrl to databaseUrl", () => {
    const env = {
      [MIGRATE_REGIONS_ENV]: JSON.stringify([
        { name: "us-east-1", databaseUrl: "postgresql://us" },
        {
          name: "eu-west-1",
          databaseUrl: "postgresql://eu-pool",
          directUrl: "postgresql://eu-direct",
        },
      ]),
    };
    expect(resolveMigrationTargets(env)).toEqual([
      { name: "us-east-1", databaseUrl: "postgresql://us", directUrl: "postgresql://us" },
      {
        name: "eu-west-1",
        databaseUrl: "postgresql://eu-pool",
        directUrl: "postgresql://eu-direct",
      },
    ]);
  });

  it("ignores the ambient DATABASE_URL once MIGRATE_REGIONS is set", () => {
    const env = {
      DATABASE_URL: DB,
      [MIGRATE_REGIONS_ENV]: JSON.stringify([{ name: "only", databaseUrl: "postgresql://only" }]),
    };
    const out = resolveMigrationTargets(env);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "only", databaseUrl: "postgresql://only" });
  });

  it("throws on malformed JSON", () => {
    expect(() => resolveMigrationTargets({ [MIGRATE_REGIONS_ENV]: "{not json" })).toThrow(
      /not valid JSON/,
    );
  });

  it("throws when the JSON is not an array", () => {
    expect(() =>
      resolveMigrationTargets({
        [MIGRATE_REGIONS_ENV]: JSON.stringify({ name: "x", databaseUrl: DB }),
      }),
    ).toThrow(/non-empty JSON array/);
  });

  it("throws on an empty array", () => {
    expect(() => resolveMigrationTargets({ [MIGRATE_REGIONS_ENV]: "[]" })).toThrow(
      /non-empty JSON array/,
    );
  });

  it("throws when an entry is not an object", () => {
    expect(() =>
      resolveMigrationTargets({ [MIGRATE_REGIONS_ENV]: JSON.stringify(["nope"]) }),
    ).toThrow(/\[0\] must be an object/);
  });

  it("throws when name is missing or blank", () => {
    expect(() =>
      resolveMigrationTargets({ [MIGRATE_REGIONS_ENV]: JSON.stringify([{ databaseUrl: DB }]) }),
    ).toThrow(/\[0\]\.name is required/);
  });

  it("throws when databaseUrl is missing", () => {
    expect(() =>
      resolveMigrationTargets({ [MIGRATE_REGIONS_ENV]: JSON.stringify([{ name: "us" }]) }),
    ).toThrow(/databaseUrl is required/);
  });

  it("throws when directUrl is present but blank", () => {
    expect(() =>
      resolveMigrationTargets({
        [MIGRATE_REGIONS_ENV]: JSON.stringify([{ name: "us", databaseUrl: DB, directUrl: "  " }]),
      }),
    ).toThrow(/directUrl, if present/);
  });

  it("throws on duplicate region names", () => {
    expect(() =>
      resolveMigrationTargets({
        [MIGRATE_REGIONS_ENV]: JSON.stringify([
          { name: "us", databaseUrl: "postgresql://a" },
          { name: "us", databaseUrl: "postgresql://b" },
        ]),
      }),
    ).toThrow(/duplicate region name "us"/);
  });
});

describe("envForTarget", () => {
  const target: MigrationTarget = {
    name: "eu",
    databaseUrl: "postgresql://pool",
    directUrl: "postgresql://direct",
  };

  it("swaps in the target's DATABASE_URL and DIRECT_URL", () => {
    const out = envForTarget(target, { DATABASE_URL: "old", DIRECT_URL: "old-direct" });
    expect(out.DATABASE_URL).toBe("postgresql://pool");
    expect(out.DIRECT_URL).toBe("postgresql://direct");
  });

  it("preserves other env vars (e.g. PATH) so the prisma bin still resolves", () => {
    const out = envForTarget(target, { PATH: "/node_modules/.bin", DATABASE_URL: "old" });
    expect(out.PATH).toBe("/node_modules/.bin");
  });

  it("does not mutate the base env", () => {
    const base = { DATABASE_URL: "old", DIRECT_URL: "old-direct" };
    envForTarget(target, base);
    expect(base).toEqual({ DATABASE_URL: "old", DIRECT_URL: "old-direct" });
  });
});
