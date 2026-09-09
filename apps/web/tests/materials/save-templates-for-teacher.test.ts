import { describe, expect, it, vi, beforeEach } from "vitest";

const state = { pro: true };
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(async () =>
    state.pro ? { ok: true } : { ok: false, limit: "class_content" },
  ),
  upgradeNudge: vi.fn(() => "UPGRADE"),
}));

import { saveClassContentTemplatesForTeacher } from "@/lib/materials/templates";

// saveClassContentTemplatesForTeacher — the replace-set manager save.
// Takes an injectable `db`, so we exercise create/update/delete/reorder logic
// with a hand-rolled fake (mirrors the focus-tags lib test).

type FakeRow = { id: string; label: string; body: string; position: number; teacherId: string };

function fakeDb(initial: FakeRow[] = []) {
  const rows = [...initial];
  let nextId = 0;
  return {
    rows,
    classContentTemplate: {
      create: vi.fn(async ({ data }: { data: Omit<FakeRow, "id"> }) => {
        const row = { id: `new-${nextId++}`, ...data };
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of rows) {
          if (r.id === where.id && r.teacherId === where.teacherId) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].id === where.id && rows[i].teacherId === where.teacherId) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        return rows
          .filter((r) => r.teacherId === where.teacherId)
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((r) => ({ id: r.id, label: r.label, body: r.body }));
      }),
    },
  };
}

beforeEach(() => {
  state.pro = true;
});

describe("saveClassContentTemplatesForTeacher", () => {
  it("blocks a Free teacher with the upgrade nudge and writes nothing", async () => {
    state.pro = false;
    const db = fakeDb();
    const r = await saveClassContentTemplatesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ label: "M", body: "## Hi", keep: true }] },
      db as any,
    );
    expect(r).toEqual({ ok: false, code: "not-pro", message: "UPGRADE" });
    expect(db.rows).toHaveLength(0);
  });

  it("creates an id-less kept row with position by array order", async () => {
    const db = fakeDb();
    const r = await saveClassContentTemplatesForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [
          { label: "First", body: "## A", keep: true },
          { label: "Second", body: "## B", keep: true },
        ],
      },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0]).toMatchObject({ label: "First", body: "## A", position: 0 });
    expect(db.rows[1]).toMatchObject({ label: "Second", body: "## B", position: 1 });
  });

  it("discards an id-less row added then removed in the same submission", async () => {
    const db = fakeDb();
    const r = await saveClassContentTemplatesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ label: "Nope", body: "## X", keep: false }] },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(db.rows).toHaveLength(0);
  });

  it("hard-deletes a kept-false existing row, scoped to the owning teacher", async () => {
    const db = fakeDb([{ id: "a", label: "Old", body: "## Old", position: 0, teacherId: "t1" }]);
    const r = await saveClassContentTemplatesForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [{ id: "a", label: "Old", body: "## Old", keep: false }],
      },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(db.rows).toHaveLength(0);
  });

  it("edits body + label, reorders, and never touches another teacher's row", async () => {
    const db = fakeDb([
      { id: "a", label: "A", body: "## A", position: 0, teacherId: "t1" },
      { id: "b", label: "B", body: "## B", position: 1, teacherId: "t1" },
      { id: "x", label: "Theirs", body: "## Theirs", position: 0, teacherId: "t2" },
    ]);
    const r = await saveClassContentTemplatesForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [
          { id: "b", label: "B", body: "## B edited", keep: true },
          { id: "a", label: "A renamed", body: "## A", keep: true },
          { id: "x", label: "Hijack", body: "## hijack", keep: true },
        ],
      },
      db as any,
    );
    expect(r.ok).toBe(true);
    const a = db.rows.find((row) => row.id === "a")!;
    const b = db.rows.find((row) => row.id === "b")!;
    const x = db.rows.find((row) => row.id === "x")!;
    expect(b.position).toBe(0);
    expect(b.body).toBe("## B edited");
    expect(a.position).toBe(1);
    expect(a.label).toBe("A renamed");
    // Cross-tenant id in the payload is a no-op — never edited, never repositioned.
    expect(x.label).toBe("Theirs");
    expect(x.position).toBe(0);
  });

  it("rejects a blank name or empty body and writes nothing", async () => {
    const db = fakeDb();
    const blankName = await saveClassContentTemplatesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ label: "   ", body: "## Hi", keep: true }] },
      db as any,
    );
    expect(blankName.ok).toBe(false);
    const emptyBody = await saveClassContentTemplatesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ label: "Named", body: "   ", keep: true }] },
      db as any,
    );
    expect(emptyBody.ok).toBe(false);
    expect(db.rows).toHaveLength(0);
  });
});
