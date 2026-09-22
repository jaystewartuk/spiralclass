import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_setup/test-db";
import { buildPoolConfig } from "@/lib/db-pool";

/**
 * How many statements Prisma actually puts on the wire per query.
 *
 * WHY THIS EXISTS. `fly.production.toml` and [D-150] both cost the app's
 * latency on a stated multiplier:
 *
 *   > Prisma spends FOUR round trips on every single query
 *   > (BEGIN → query → COMMIT → DEALLOCATE ALL)
 *
 * That number decided a region (Fly `ord` over `dfw`), and it decided against
 * free hosting in [D-150] — 58 ms × 28 round trips is the ~1.3 s that record
 * refused to pay. [D-184] then quoted it again to argue Cloud Run's +9 ms was
 * affordable.
 *
 * ⚠️ **Nothing has ever verified it.** It is the documented signature of
 * Prisma ≤6's Rust engine with `pgbouncer=true` in the connection string. This
 * repository is on Prisma 7 with `@prisma/adapter-pg`, and `lib/db-pool.ts`
 * strips `pgbouncer` as an engine-only parameter — so the premise behind the
 * multiplier may have expired two major versions ago, and every decision
 * resting on it would be four times more cautious than the evidence supports.
 *
 * CLAUDE.md's fourth rule is the whole reason this is a test and not a
 * paragraph: "A claim nothing verifies is a claim that is eventually false.
 * Prefer an executable check to a sentence."
 *
 * HOW IT MEASURES. The adapter accepts a `pg.Pool`, so this hands it a real
 * one whose `query` is recorded — on the pool AND on every client `connect()`
 * hands out, because the adapter runs transactions on a checked-out client and
 * a wrapper that watched only the pool would miss exactly the BEGIN/COMMIT
 * this exists to count. What lands in `sql` is therefore what Prisma sent, not
 * what Prisma reported sending.
 *
 * It counts STATEMENTS, which is the honest name for it. A statement is a round
 * trip here because node-postgres sends unnamed portals and waits for each
 * reply, and because the adapter never names a prepared statement
 * (`lib/db-pool.ts` explains why) — so there is no pipelining to make the two
 * diverge.
 */
describeIntegration("what Prisma puts on the wire (D-150's multiplier)", () => {
  let sql: string[] = [];
  let prisma: PrismaClient;
  let pool: Pool;

  /** Everything the pool and its clients were asked to run, in order. */
  function recordingPool(url: string): Pool {
    const real = new Pool(buildPoolConfig(url));
    const note = (text: unknown) => {
      if (typeof text === "string") sql.push(text);
      else if (text && typeof text === "object" && "text" in text) {
        sql.push(String((text as { text: unknown }).text));
      }
    };

    // ⚠️ ONLY the checked-out client is wrapped, never `pool.query` as well.
    // node-postgres implements `Pool.query` by checking out a client and
    // calling ITS `query`, so wrapping both counted every statement twice —
    // which read as "an include costs 2 statements" and would have been
    // mistaken for a relation loading separately.
    //
    // ⚠️ `pool.connect` has BOTH a promise and a callback form, and pg picks by
    // whether it was handed a function. An `async` override answers the promise
    // form for everything, so the callback form got `undefined` back — which
    // surfaced as five unhandled rejections and, worse, as a recorder that
    // silently missed whichever client the adapter had checked out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrap = (client: any) => {
      // A pooled client is handed out many times; wrapping twice would count
      // every statement twice.
      if (!client || client.__recordingWrapped) return client;
      client.__recordingWrapped = true;
      const clientQuery = client.query.bind(client);
      client.query = (...inner: unknown[]) => {
        note(inner[0]);
        return clientQuery(...inner);
      };
      return client;
    };

    const poolConnect = real.connect.bind(real);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (real as any).connect = (callback?: unknown) => {
      if (typeof callback === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (poolConnect as any)((err: unknown, client: any, release: unknown) =>
          (callback as (e: unknown, c: unknown, r: unknown) => void)(err, wrap(client), release),
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (poolConnect as any)().then(wrap);
    };

    return real;
  }

  beforeAll(() => {
    pool = recordingPool(process.env.TEST_DATABASE_URL!);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: ["warn", "error"] });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  /** Runs `work` and returns only the statements it caused. */
  async function statementsFor(work: () => Promise<unknown>): Promise<string[]> {
    // A first call on a cold pool also runs the driver's own setup, which is
    // not per-query cost and would be charged to whichever test ran first.
    sql = [];
    await work();
    return [...sql];
  }

  beforeAll(async () => {
    // Warm the pool before anything is counted, for the reason above.
    await prisma.$queryRaw`SELECT 1`;
  });

  const wrapping = (statements: string[]) =>
    statements.filter((s) => /^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)/i.test(s));

  it("issues ONE statement for a simple read, with no transaction wrapping", async () => {
    const statements = await statementsFor(() => prisma.teacher.findMany({ take: 1 }));

    // The assertion that matters. If this ever fails with BEGIN/COMMIT around
    // a plain read, D-150's multiplier is live again and every latency figure
    // derived from it — D-184's included — needs re-deriving, not re-quoting.
    expect(wrapping(statements), `Prisma wrapped a plain read: ${statements.join(" | ")}`).toEqual(
      [],
    );
    expect(statements).toHaveLength(1);
  });

  it("does not DEALLOCATE after a query", async () => {
    // `DEALLOCATE ALL` was the fourth of the four. It only ever appeared
    // because the engine used NAMED prepared statements; the adapter does not.
    const statements = await statementsFor(() => prisma.teacher.findMany({ take: 1 }));
    expect(statements.some((s) => /DEALLOCATE/i.test(s))).toBe(false);
  });

  it("keeps a read with a relation to a single statement (relationJoins)", async () => {
    // `relationJoins` is on in schema.prisma, so an `include` should become one
    // joined query rather than a query per relation. This is the shape D-150
    // actually costed — a class-detail read — so it is the one whose statement
    // count its arithmetic depends on.
    const statements = await statementsFor(() =>
      prisma.teacher.findMany({ take: 1, include: { packages: true } }),
    );
    expect(wrapping(statements)).toEqual([]);
    expect(
      statements.length,
      `an include cost ${statements.length} statements: ${statements.join(" | ")}`,
    ).toBe(1);
  });

  it("still wraps an explicit interactive transaction, which is the point of one", async () => {
    // The counterpart: BEGIN/COMMIT have not been lost, they are simply no
    // longer charged to every read. A failure here would mean the recorder is
    // watching the wrong client rather than that Prisma stopped using
    // transactions — which is why it is asserted rather than assumed.
    const statements = await statementsFor(() =>
      prisma.$transaction(async (tx) => tx.teacher.findMany({ take: 1 })),
    );
    expect(statements.some((s) => /^\s*BEGIN/i.test(s))).toBe(true);
    expect(statements.some((s) => /^\s*COMMIT/i.test(s))).toBe(true);
  });

  it("costs ONE statement per read, not the four the tree used to claim", async () => {
    // The headline, asserted as a number rather than a range so that a
    // regression toward the old behaviour fails here and names itself. If this
    // goes back to 4, fly.production.toml's region comment, D-150's ~1.3 s and
    // D-184's +9 ms arithmetic all need re-deriving rather than re-quoting.
    const statements = await statementsFor(() => prisma.teacher.findMany({ take: 1 }));
    expect(
      statements.length,
      `a simple read cost ${statements.length} statements: ${statements.join(" | ")}`,
    ).toBe(1);
  });
});
