import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveClassContentTemplateBody (D-46) — the tenant-scoped lookup that turns a
// posted templateId into the Markdown structure fed to AI compose. The security
// property under test: only the TEACHER'S OWN template resolves; a foreign,
// unknown, or empty id yields null so the generator falls back to its default
// shape instead of leaking another teacher's structure.

const findFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { classContentTemplate: { findFirst: (a: unknown) => findFirst(a) } },
}));

const { resolveClassContentTemplateBody } = await import("@/lib/materials/templates");

beforeEach(() => {
  findFirst.mockReset();
});

describe("resolveClassContentTemplateBody", () => {
  it("returns the body of the teacher's own template", async () => {
    findFirst.mockResolvedValue({ body: "## Bienvenida\n## Objetivo" });
    const body = await resolveClassContentTemplateBody("t1", "tpl1");
    expect(body).toBe("## Bienvenida\n## Objetivo");
    // Scoped to this teacher — never a bare id lookup.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tpl1", teacherId: "t1" } }),
    );
  });

  it("returns null for a foreign / unknown id (no row for this teacher)", async () => {
    findFirst.mockResolvedValue(null);
    expect(await resolveClassContentTemplateBody("t1", "someone-elses-tpl")).toBeNull();
  });

  it("short-circuits without a query when no id is given", async () => {
    expect(await resolveClassContentTemplateBody("t1", null)).toBeNull();
    expect(await resolveClassContentTemplateBody("t1", "")).toBeNull();
    expect(await resolveClassContentTemplateBody("t1", undefined)).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only body as no template", async () => {
    findFirst.mockResolvedValue({ body: "   \n " });
    expect(await resolveClassContentTemplateBody("t1", "tpl1")).toBeNull();
  });
});
