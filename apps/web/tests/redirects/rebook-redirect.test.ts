import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// `/r/re/<bookingId>` (D-40) resolves the canceled booking, finds the
// student's email, mints a real better-auth session server-side
// (lib/auth/server-otp.ts's mintServerSideOtpSession — no email round trip),
// and 302s to /my-classes/book?packageId=<packageId> so the student can pick
// a new slot without having to sign in manually, session cookie already set.

const APP_URL = "https://app.test";

type BookingRow = {
  id: string;
  packageId: string;
  studentEmail: string | null;
};

const state: {
  bookings: BookingRow[];
  mintThrows: boolean;
  mintCalls: Array<{ email: string }>;
} = {
  bookings: [],
  mintThrows: false,
  mintCalls: [],
};

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL }),
}));

vi.mock("@/lib/auth/server-otp", () => ({
  mintServerSideOtpSession: async (email: string) => {
    state.mintCalls.push({ email });
    if (state.mintThrows) throw new Error("mint failed");
    return { token: "session-token", user: { id: "u-1", email } };
  },
}));

vi.mock("@/lib/prisma", () => {
  function bookingFindFirst({ where }: { where: { id?: string } }) {
    for (const b of state.bookings) {
      if (where.id && b.id !== where.id) continue;
      return { packageId: b.packageId, student: { email: b.studentEmail } };
    }
    return null;
  }
  return { prisma: { booking: { findFirst: bookingFindFirst } } };
});

const { GET } = await import("@/app/r/re/[bookingId]/route");

function makeReq(bookingId: string) {
  return [
    new Request(`${APP_URL}/r/re/${bookingId}`) as unknown as NextRequest,
    { params: Promise.resolve({ bookingId }) },
  ] as const;
}

beforeEach(() => {
  state.bookings = [{ id: "booking-1", packageId: "pkg-1", studentEmail: "alumno@example.com" }];
  state.mintThrows = false;
  state.mintCalls.length = 0;
});

describe("GET /r/re/[bookingId] — happy path", () => {
  it("302s to /my-classes/book with packageId pre-selected after minting a session", async () => {
    const [req, ctx] = makeReq("booking-1");
    const res = await GET(req, ctx as any);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    const locUrl = new URL(loc);
    expect(locUrl.pathname).toBe("/my-classes/book");
    expect(locUrl.searchParams.get("packageId")).toBe("pkg-1");
    expect(state.mintCalls).toEqual([{ email: "alumno@example.com" }]);
  });

  it("mints (and consumes) a fresh session on each click", async () => {
    const [req1, ctx1] = makeReq("booking-1");
    await GET(req1, ctx1 as any);
    const [req2, ctx2] = makeReq("booking-1");
    const res = await GET(req2, ctx2 as any);
    expect(res.status).toBe(302);
    expect(state.mintCalls).toHaveLength(2);
  });
});

describe("GET /r/re/[bookingId] — 404 paths", () => {
  it("404s when the booking id doesn't exist", async () => {
    const [req, ctx] = makeReq("missing-id");
    const res = await GET(req, ctx as any);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(state.mintCalls).toHaveLength(0);
  });

  it("404s when the student row has no email", async () => {
    state.bookings[0].studentEmail = null;
    const [req, ctx] = makeReq("booking-1");
    const res = await GET(req, ctx as any);
    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
  });
});

describe("GET /r/re/[bookingId] — 503 path", () => {
  it("503s when mintServerSideOtpSession throws", async () => {
    state.mintThrows = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [req, ctx] = makeReq("booking-1");
    const res = await GET(req, ctx as any);
    expect(res.status).toBe(503);
    errSpy.mockRestore();
  });
});
