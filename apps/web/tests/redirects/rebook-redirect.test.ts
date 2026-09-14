import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// `/r/re/<token>` (D-40) — the rebook button on a cancellation notice.
//
// The URL is a sign-in credential, so it is a single-use token issued at send
// time (lib/auth/notification-link.ts), never the booking id. GET renders a
// button and touches nothing, because mail scanners fetch every link; POST
// redeems the token, signs the student in, and 303s to
// /my-classes/book?packageId=<packageId>.
//
// The magic-link twin (`/r/ml/<token>`) is magic-link-redeem.test.ts; the
// behaviour both share is asserted here once.

const APP_URL = "https://app.test";

const calls = vi.hoisted(() => ({
  mint: [] as string[],
  mintThrows: false,
  link: [] as string[],
  superusers: [] as string[],
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL }),
  isSuperuser: (email: string) => calls.superusers.includes(email.toLowerCase()),
}));

vi.mock("@/lib/auth/server-otp", () => ({
  mintServerSideOtpSession: async (email: string) => {
    calls.mint.push(email);
    if (calls.mintThrows) throw new Error("mint failed");
    return { token: "session-token", user: { id: "u-1", email } };
  },
}));

vi.mock("@/lib/auth/student-link", () => ({
  resolveLinkedStudent: async (user: { id: string }) => {
    calls.link.push(user.id);
    return { status: "linked", id: "s-1", alreadyLinked: false };
  },
}));

vi.mock("@/lib/prisma", async () => {
  const { fakePrisma } = await import("./notification-link-fake");
  return { prisma: fakePrisma };
});

const { db, resetDb, fakePrisma } = await import("./notification-link-fake");
const { issueNotificationLinkToken } = await import("@/lib/auth/notification-link");
const route = await import("@/app/r/re/[token]/route");

type Handler = (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => Promise<Response>;

function call(handler: Handler, token: string, init?: RequestInit) {
  const req = new Request(`${APP_URL}/r/re/${token}`, init) as unknown as NextRequest;
  return handler(req, { params: Promise.resolve({ token }) });
}

const post = (
  token: string,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
) => call(route.POST, token, { method: "POST", headers });

function issue(
  overrides: Partial<{ studentId: string; email: string; subjectId: string }> = {},
  now?: Date,
) {
  return issueNotificationLinkToken(
    fakePrisma as never,
    {
      kind: "rebook",
      studentId: "s-1",
      email: "alumna@example.com",
      subjectId: "booking-1",
      ...overrides,
    },
    now,
  );
}

beforeEach(() => {
  resetDb();
  calls.mint.length = 0;
  calls.link.length = 0;
  calls.mintThrows = false;
  calls.superusers = [];
});

describe("POST /r/re/[token] — a valid link", () => {
  it("signs the student in and 303s to the book page for the canceled class's credits", async () => {
    const res = await post(await issue());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP_URL}/my-classes/book?packageId=pkg-1`);
    expect(calls.mint).toEqual(["alumna@example.com"]);
    expect(calls.link).toEqual(["u-1"]);
  });

  it("works once: a second use is the expired page and mints nothing", async () => {
    const token = await issue();
    await post(token);
    const res = await post(token);
    expect(res.status).toBe(404);
    expect(calls.mint).toHaveLength(1);
  });

  it("503s when minting the session fails", async () => {
    calls.mintThrows = true;
    const res = await post(await issue());
    expect(res.status).toBe(503);
  });
});

describe("the regression: a booking id is not a credential", () => {
  it("a bare booking id posted to the route is the expired page and mints nothing", async () => {
    const res = await post("booking-1");
    expect(res.status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("a booking UUID is refused the same way", async () => {
    db.bookings[0].id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const res = await post("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(res.status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("GET never mints, whatever it is given", async () => {
    for (const token of ["booking-1", await issue()]) {
      const res = await call(route.GET, token);
      expect(res.status).toBe(200);
    }
    expect(calls.mint).toHaveLength(0);
  });
});

describe("GET /r/re/[token] — the button, for link scanners and people alike", () => {
  it("renders a same-page POST form and leaves the token unspent", async () => {
    const token = await issue();
    const res = await call(route.GET, token);
    const html = await res.text();

    expect(html).toContain(`<form method="POST" action="/r/re/${token}">`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(db.verification).toHaveLength(1);
    // The scanner's GET did not spend it: the reader's press still works.
    expect((await post(token)).status).toBe(303);
  });

  it("escapes whatever sits in the path", async () => {
    const res = await call(route.GET, '"><script>x</script>');
    const html = await res.text();
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("POST /r/re/[token] — refusals", () => {
  it("refuses a post from another site, without spending the token", async () => {
    const token = await issue();
    const res = await post(token, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(calls.mint).toHaveLength(0);
    expect((await post(token)).status).toBe(303);
  });

  it("refuses a magic-link token", async () => {
    const token = await issueNotificationLinkToken(fakePrisma as never, {
      kind: "magic-link",
      studentId: "s-1",
      email: "alumna@example.com",
      subjectId: "notif-1",
    });
    const res = await post(token);
    expect(res.status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("refuses a lapsed link", async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const res = await post(await issue({}, fourDaysAgo));
    expect(res.status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("refuses a link whose student row now carries a different address", async () => {
    const token = await issue();
    db.students[0].email = "someone-else@example.com";
    const res = await post(token);
    expect(res.status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("refuses a link whose booking no longer belongs to that student", async () => {
    const token = await issue();
    db.bookings[0].studentId = "s-2";
    const res = await post(token);
    expect(res.status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("refuses a link whose student row is gone", async () => {
    const token = await issue();
    db.students = [];
    expect((await post(token)).status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("sends a disabled student to the ordinary sign-in", async () => {
    const token = await issue();
    db.students[0].disabledAt = new Date();
    const res = await post(token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP_URL}/sign-in`);
    expect(calls.mint).toHaveLength(0);
  });

  it("sends a teacher's address to the ordinary sign-in", async () => {
    db.students[0].email = "PROFE@example.com";
    const res = await post(await issue({ email: "profe@example.com" }));
    expect(res.headers.get("location")).toBe(`${APP_URL}/sign-in`);
    expect(calls.mint).toHaveLength(0);
  });

  it("…including a teacher whose account is found through her login rather than her row's email", async () => {
    db.teachers = [{ id: "t-9", email: "old-address@example.com" }];
    db.users = [{ id: "t-9", email: "alumna@example.com" }];
    const res = await post(await issue());
    expect(res.headers.get("location")).toBe(`${APP_URL}/sign-in`);
    expect(calls.mint).toHaveLength(0);
  });

  it("sends an admin's address to the ordinary sign-in", async () => {
    db.adminEmails = ["alumna@example.com"];
    const res = await post(await issue());
    expect(res.headers.get("location")).toBe(`${APP_URL}/sign-in`);
    expect(calls.mint).toHaveLength(0);
  });

  it("sends a superuser's address to the ordinary sign-in", async () => {
    calls.superusers = ["alumna@example.com"];
    const res = await post(await issue());
    expect(res.headers.get("location")).toBe(`${APP_URL}/sign-in`);
    expect(calls.mint).toHaveLength(0);
  });
});

describe("the expired-link page", () => {
  // Rendered to a reader with no session, so it follows the request's language.
  // tests/setup.ts pins the suite's `locale` cookie to es-MX.
  it("renders in the locale the request asks for", async () => {
    const res = await post("missing");
    const html = await res.text();
    expect(html).toContain('lang="es-MX"');
    expect(html).toContain("El enlace para reagendar tu clase ya no está disponible.");
  });

  it("renders in English when the request asks for nothing in particular", async () => {
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: () => undefined }),
      headers: async () => ({ get: () => null }),
    }));
    vi.resetModules();
    const fresh = await import("@/app/r/re/[token]/route");
    const res = await call(fresh.POST, "missing", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    const html = await res.text();
    expect(html).toContain('lang="en"');
    expect(html).toContain("The link to rebook your class is no longer available.");
    // Restore rather than doUnmock — see the note in magic-link-redeem.test.ts.
    vi.doMock("next/headers", () => ({
      cookies: async () => ({
        get: (name: string) => (name === "locale" ? { value: "es-MX" } : undefined),
      }),
      headers: async () => ({ get: () => null }),
    }));
    vi.resetModules();
  });

  // The link out is its own element rather than an <a> inside the sentence,
  // so the sentence can live in the catalog. It still points where it should.
  it("keeps the way back to /my-classes", async () => {
    const res = await post("missing");
    expect(await res.text()).toContain('href="/my-classes"');
  });
});
