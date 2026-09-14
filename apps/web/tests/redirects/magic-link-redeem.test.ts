import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// `/r/ml/<token>` (D-40) — the portal sign-in link sent after a student's first
// paid checkout. Same mechanism as `/r/re/<token>` (rebook-redirect.test.ts,
// which asserts the shared behaviour: GET never mints, cross-site posts, the
// teacher/admin/disabled refusals). This suite covers what is particular to
// the magic link: the notification it names, the pairing it must still stand
// on, and linking the login to the roster row.

const APP_URL = "https://app.test";

const calls = vi.hoisted(() => ({
  mint: [] as string[],
  link: [] as string[],
  linkThrows: false,
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL }),
  isSuperuser: () => false,
}));

vi.mock("@/lib/auth/server-otp", () => ({
  mintServerSideOtpSession: async (email: string) => {
    calls.mint.push(email);
    return { token: "session-token", user: { id: "u-1", email } };
  },
}));

vi.mock("@/lib/auth/student-link", () => ({
  resolveLinkedStudent: async (user: { id: string }) => {
    calls.link.push(user.id);
    if (calls.linkThrows) throw new Error("link failed");
    return { status: "none" };
  },
}));

vi.mock("@/lib/prisma", async () => {
  const { fakePrisma } = await import("./notification-link-fake");
  return { prisma: fakePrisma };
});

const { db, resetDb, fakePrisma } = await import("./notification-link-fake");
const { issueNotificationLinkToken } = await import("@/lib/auth/notification-link");
const route = await import("@/app/r/ml/[token]/route");

type Handler = (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => Promise<Response>;

function call(handler: Handler, token: string, init?: RequestInit) {
  const req = new Request(`${APP_URL}/r/ml/${token}`, init) as unknown as NextRequest;
  return handler(req, { params: Promise.resolve({ token }) });
}

const post = (token: string) =>
  call(route.POST, token, { method: "POST", headers: { "sec-fetch-site": "same-origin" } });

const issue = (kind: "magic-link" | "rebook" = "magic-link", subjectId = "notif-1") =>
  issueNotificationLinkToken(fakePrisma as never, {
    kind,
    studentId: "s-1",
    email: "alumna@example.com",
    subjectId,
  });

/** Put tests/setup.ts's `next/headers` mock back after a test replaced it. */
function restoreSuiteHeaders() {
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) => (name === "locale" ? { value: "es-MX" } : undefined),
    }),
    headers: async () => ({ get: () => null }),
  }));
  vi.resetModules();
}

beforeEach(() => {
  resetDb();
  calls.mint.length = 0;
  calls.link.length = 0;
  calls.linkThrows = false;
});

describe("POST /r/ml/[token] — a valid link", () => {
  it("signs the student in, links the login to her row, and 303s to /my-classes", async () => {
    const res = await post(await issue());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP_URL}/my-classes`);
    expect(calls.mint).toEqual(["alumna@example.com"]);
    expect(calls.link).toEqual(["u-1"]);
  });

  it("still lands her signed in when linking the row fails — requireStudent retries it", async () => {
    calls.linkThrows = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(await issue());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP_URL}/my-classes`);
    errSpy.mockRestore();
  });

  it("works once", async () => {
    const token = await issue();
    await post(token);
    expect((await post(token)).status).toBe(404);
    expect(calls.mint).toHaveLength(1);
  });
});

describe("the regression: a notification id is not a credential", () => {
  it("a bare notification id is the expired page and mints nothing", async () => {
    const res = await post("notif-1");
    expect(res.status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("GET renders the button and mints nothing", async () => {
    const token = await issue();
    const res = await call(route.GET, token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`action="/r/ml/${token}"`);
    expect(calls.mint).toHaveLength(0);
  });
});

describe("POST /r/ml/[token] — refusals", () => {
  it("refuses a rebook token", async () => {
    const res = await post(await issue("rebook", "booking-1"));
    expect(res.status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("refuses when the notification is not a magic link", async () => {
    const token = await issue();
    db.notifications[0].templateName = "booking_confirmation";
    expect((await post(token)).status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("refuses when the notification is addressed to someone else", async () => {
    const token = await issue();
    db.notifications[0].recipientId = "s-2";
    expect((await post(token)).status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("refuses when the notification's recipient is a teacher", async () => {
    const token = await issue();
    db.notifications[0].recipientType = "teacher";
    expect((await post(token)).status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("tenant isolation: refuses when the student is no longer on that teacher's roster", async () => {
    const token = await issue();
    db.pairings = [{ teacherId: "t-OTHER", studentId: "s-1" }];
    expect((await post(token)).status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });

  it("refuses when the student row has no email", async () => {
    const token = await issue();
    db.students[0].email = null;
    expect((await post(token)).status).toBe(404);
    expect(calls.mint).toHaveLength(0);
  });
});

describe("the expired-link page", () => {
  // This page renders to a reader with no session, and its whole job is
  // telling them what to do next — so it has to be in a language they asked
  // for. tests/setup.ts pins the suite's `locale` cookie, so the two cases
  // below are "follows the cookie" and "falls back to DEFAULT_LOCALE".
  //
  // (tests/i18n/no-spanish-default.test.ts covers the rule across every
  // surface, including French; these keep the assertion next to the route's
  // own branches.)
  it("renders in the locale the request asks for", async () => {
    const res = await post("missing");
    const html = await res.text();
    expect(html).toContain('lang="es-MX"');
    expect(html).toContain("Este enlace ya no funciona");
  });

  it("renders in English when the request asks for nothing in particular", async () => {
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: () => undefined }),
      headers: async () => ({ get: () => null }),
    }));
    vi.resetModules();
    const fresh = await import("@/app/r/ml/[token]/route");
    const res = await call(fresh.POST, "missing", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    const html = await res.text();
    expect(html).toContain('lang="en"');
    expect(html).toContain("This link no longer works");
    expect(html).not.toContain("Este enlace");
    // Restore the suite's mock rather than doUnmock, which drops
    // tests/setup.ts's `next/headers` mock too and leaves later tests reading
    // the real one — it throws outside a request scope, lands on the
    // DEFAULT_LOCALE catch, and passes an English assertion for the wrong reason.
    restoreSuiteHeaders();
  });
});
