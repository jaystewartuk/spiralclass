import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// D-64: platformCurrency() used to read a single platform-wide env var
// (WISE_BALANCE_CURRENCY) for every teacher — a non-MXN-priced Wise-rail
// teacher's incoming credits were never fetched at all. This pins the fix:
// wiseClientForTeacher resolves the balance to poll from the teacher's own
// `pricingCurrency`, not a global default.

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({}),
}));

const { wiseClientForTeacher } = await import("@/lib/wise/api");

const CREDS_BASE = {
  enabled: true,
  wiseApiProfileId: "profile-1",
  wiseApiTokenEnc: "plaintext-token",
  wiseApiKeyEnc: "plaintext-key",
};

function stubFetch(balances: Array<{ id: number; currency: string }>) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url);
    if (url.includes("/balances")) {
      return new Response(JSON.stringify(balances), { status: 200 });
    }
    if (url.includes("/balance-statements/")) {
      return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return urls;
}

describe("wiseClientForTeacher — per-teacher balance currency", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the COP balance for a COP-priced teacher, not MXN", async () => {
    const urls = stubFetch([
      { id: 1, currency: "MXN" },
      { id: 2, currency: "COP" },
    ]);
    const client = wiseClientForTeacher({ ...CREDS_BASE, pricingCurrency: "COP" });
    expect(client).not.toBeNull();

    await client!.fetchIncomingCredits({ since: new Date("2026-07-01T00:00:00Z") });

    const statementUrl = urls.find((u) => u.includes("/balance-statements/"));
    expect(statementUrl).toContain("/balance-statements/2/");
    expect(statementUrl).toContain("currency=COP");
  });

  it("fetches the MXN balance for an MXN-priced teacher", async () => {
    const urls = stubFetch([
      { id: 1, currency: "MXN" },
      { id: 2, currency: "COP" },
    ]);
    const client = wiseClientForTeacher({ ...CREDS_BASE, pricingCurrency: "MXN" });

    await client!.fetchIncomingCredits({ since: new Date("2026-07-01T00:00:00Z") });

    const statementUrl = urls.find((u) => u.includes("/balance-statements/"));
    expect(statementUrl).toContain("/balance-statements/1/");
    expect(statementUrl).toContain("currency=MXN");
  });

  it("throws when the teacher's own currency has no matching balance on the profile", async () => {
    stubFetch([{ id: 1, currency: "MXN" }]);
    const client = wiseClientForTeacher({ ...CREDS_BASE, pricingCurrency: "ARS" });

    await expect(
      client!.fetchIncomingCredits({ since: new Date("2026-07-01T00:00:00Z") }),
    ).rejects.toThrow(/no ARS balance/);
  });
});
