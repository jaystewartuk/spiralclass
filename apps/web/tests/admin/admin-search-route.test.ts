import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// GET /api/admin/search — the nav bar's quick-jump lookup (top 5 teachers +
// top 5 students by name/email). Pins: the auth gate, the empty-query
// short-circuit (no DB hit), and the OR/insensitive query shape.

const requireAdminMock = vi.fn(async (..._: unknown[]) => ({
  id: "admin-1",
  email: "a@b.co",
  role: "support",
}));
vi.mock("@/lib/admin", () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

const teacherFindManyMock = vi.fn(async (..._: unknown[]) => [
  { id: "t1", name: "Mira", email: "mira@x.com" },
]);
const studentFindManyMock = vi.fn(async (..._: unknown[]) => [
  { id: "s1", name: "Beto", email: "beto@x.com" },
]);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findMany: (...a: unknown[]) => teacherFindManyMock(...a) },
    student: { findMany: (...a: unknown[]) => studentFindManyMock(...a) },
  },
}));

const { GET } = await import("@/app/api/admin/search/route");

function get(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/admin/search", () => {
  it("requires at least support role", async () => {
    await GET(get("https://test.local/api/admin/search?q=mira"));
    expect(requireAdminMock).toHaveBeenCalledWith("support");
  });

  it("returns empty results without querying the DB when q is missing", async () => {
    const res = await GET(get("https://test.local/api/admin/search"));
    expect(await res.json()).toEqual({ teachers: [], students: [] });
    expect(teacherFindManyMock).not.toHaveBeenCalled();
    expect(studentFindManyMock).not.toHaveBeenCalled();
  });

  it("returns empty results for a blank/whitespace-only q", async () => {
    const res = await GET(get("https://test.local/api/admin/search?q=%20%20"));
    expect(await res.json()).toEqual({ teachers: [], students: [] });
    expect(teacherFindManyMock).not.toHaveBeenCalled();
  });

  it("queries both teacher and student by name/email, case-insensitive", async () => {
    const res = await GET(get("https://test.local/api/admin/search?q=mira"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      teachers: [{ id: "t1", name: "Mira", email: "mira@x.com" }],
      students: [{ id: "s1", name: "Beto", email: "beto@x.com" }],
    });
    expect(teacherFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { name: { contains: "mira", mode: "insensitive" } },
            { email: { contains: "mira", mode: "insensitive" } },
          ],
        },
        take: 5,
      }),
    );
  });
});
