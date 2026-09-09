import { afterEach, describe, expect, it } from "vitest";
import { assertNotProductionTarget, withOverridesDeletable } from "../../scripts/seed";

// The seed cleanup disables the append-only `overrides` audit guard (D-25) and
// hard-deletes teachers, so `withOverridesDeletable` must refuse outright when
// pointed at the production database. Post-D-89 the guard is ENV-DRIVEN:
// `PROD_DB_HOSTS` lists the production DB hostname(s), and the guard refuses when
// DATABASE_URL / DIRECT_URL resolve to one of them — a no-op when PROD_DB_HOSTS
// is unset (local/preview). These tests cover only the refusal/allow paths (no
// DB needed — the guard throws before the transaction callback runs); the
// allow-and-delete path is exercised by cleanup.integration.test.ts.
const NEON_PROD_HOST = "ep-prod-example-1234.us-east-2.aws.neon.tech";
const ENV_KEYS = ["PROD_DB_HOSTS", "DATABASE_URL", "DIRECT_URL"] as const;

describe("withOverridesDeletable production guard", () => {
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  // Fake client: the guard throws before the transaction callback runs, so the
  // client is never touched.
  const fakePrisma = {} as never;

  it("refuses when DATABASE_URL's host is in PROD_DB_HOSTS", async () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv("PROD_DB_HOSTS", NEON_PROD_HOST);
    setEnv("DATABASE_URL", `postgresql://u:p@${NEON_PROD_HOST}:5432/spiralclass`);

    let ran = false;
    await expect(
      withOverridesDeletable(fakePrisma, async () => {
        ran = true;
        return "unreachable";
      }),
    ).rejects.toThrow(/production database host/);
    expect(ran).toBe(false);
  });

  it("refuses when DIRECT_URL matches one of several PROD_DB_HOSTS entries", async () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv("PROD_DB_HOSTS", `other-pooler.example.com, ${NEON_PROD_HOST}`);
    setEnv("DIRECT_URL", `postgresql://u:p@${NEON_PROD_HOST}:5432/spiralclass`);

    await expect(withOverridesDeletable(fakePrisma, async () => "x")).rejects.toThrow(/production/);
  });
});

describe("assertNotProductionTarget host gate", () => {
  const saved = new Map<string, string | undefined>();
  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it("allows a local / preview target whose host isn't in PROD_DB_HOSTS", () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv("PROD_DB_HOSTS", NEON_PROD_HOST);
    setEnv("DATABASE_URL", "postgresql://test@127.0.0.1:5433/spiralclass_test");
    setEnv("DIRECT_URL", "postgresql://test@127.0.0.1:5433/spiralclass_test");
    expect(() => assertNotProductionTarget()).not.toThrow();
  });

  it("is a no-op when PROD_DB_HOSTS is unset (nothing to guard against)", () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    // Even a prod-looking host passes when no prod hosts are configured — the
    // guard only bites where the prod connection could actually be present.
    setEnv("DATABASE_URL", `postgresql://u@${NEON_PROD_HOST}:5432/spiralclass`);
    expect(() => assertNotProductionTarget()).not.toThrow();
  });

  it("tolerates a malformed connection string without throwing on parse", () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv("PROD_DB_HOSTS", NEON_PROD_HOST);
    setEnv("DATABASE_URL", "not-a-url");
    expect(() => assertNotProductionTarget()).not.toThrow();
  });
});
