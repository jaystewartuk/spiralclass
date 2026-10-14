import { describe, expect, it } from "vitest";
import { sortRows } from "./table-sort";

type Row = { id: string; name: string; count: number | null };

const rows: Row[] = [
  { id: "b", name: "Beatriz", count: 2 },
  { id: "a", name: "Alba", count: null },
  { id: "c", name: "Carlos", count: 5 },
];

const columns = [
  { key: "name", label: "Name", get: (r: Row) => r.name },
  { key: "count", label: "Count", get: (r: Row) => r.count },
];

describe("sortRows", () => {
  it("sorts ascending by a string column", () => {
    const sorted = sortRows(rows, columns, { key: "name", dir: "asc" });
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts descending by a string column", () => {
    const sorted = sortRows(rows, columns, { key: "name", dir: "desc" });
    expect(sorted.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts numerically, pushing nulls to the end regardless of direction", () => {
    const asc = sortRows(rows, columns, { key: "count", dir: "asc" });
    expect(asc.map((r) => r.id)).toEqual(["b", "c", "a"]);

    const desc = sortRows(rows, columns, { key: "count", dir: "desc" });
    expect(desc.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate the input array", () => {
    const original = [...rows];
    sortRows(rows, columns, { key: "name", dir: "asc" });
    expect(rows).toEqual(original);
  });

  it("falls back to the first column for an unknown sort key", () => {
    const sorted = sortRows(rows, columns, { key: "unknown", dir: "asc" });
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("null ordering", () => {
  it("treats two nulls as equal, keeping their original order", () => {
    const nulls: Row[] = [
      { id: "x", name: "X", count: null },
      { id: "y", name: "Y", count: null },
    ];
    for (const dir of ["asc", "desc"] as const) {
      expect(sortRows(nulls, columns, { key: "count", dir }).map((r) => r.id)).toEqual(["x", "y"]);
    }
  });
});
