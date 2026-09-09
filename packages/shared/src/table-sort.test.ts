import { describe, expect, it } from "vitest";
import { compareValues, sortRows, type SortColumn } from "./table-sort";

type Row = { id: string; name: string; count: number | null };

const rows: Row[] = [
  { id: "b", name: "Beatriz", count: 2 },
  { id: "a", name: "Alba", count: null },
  { id: "c", name: "Carlos", count: 5 },
];

const columns: SortColumn<Row>[] = [
  { key: "name", label: "Name", get: (r) => r.name },
  { key: "count", label: "Count", get: (r) => r.count },
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

describe("compareValues", () => {
  it("treats two nulls as equal", () => {
    expect(compareValues(null, undefined, "asc")).toBe(0);
  });

  it("sorts a null value after a defined one in both directions", () => {
    expect(compareValues(null, 1, "asc")).toBeGreaterThan(0);
    expect(compareValues(null, 1, "desc")).toBeGreaterThan(0);
    expect(compareValues(1, null, "asc")).toBeLessThan(0);
  });
});
