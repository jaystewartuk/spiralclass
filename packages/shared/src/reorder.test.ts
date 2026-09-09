import { describe, expect, it } from "vitest";

import { moveArrayItem, moveGroupItemToEdge, moveWithinGroup, reassignItemGroup } from "./reorder";

type Row = { id: string; categoryId: string };

const rows: Row[] = [
  { id: "a", categoryId: "grammar" },
  { id: "b", categoryId: "vocab" },
  { id: "c", categoryId: "grammar" },
  { id: "d", categoryId: "vocab" },
  { id: "e", categoryId: "grammar" },
];
const categoryOf = (r: Row) => r.categoryId;
const ids = (list: Row[]) => list.map((r) => r.id);

describe("moveArrayItem", () => {
  it("moves an item forward, shifting the rest back", () => {
    expect(moveArrayItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item backward, shifting the rest forward", () => {
    expect(moveArrayItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("is a no-op (same reference) for an identity move", () => {
    const arr = ["a", "b"];
    expect(moveArrayItem(arr, 1, 1)).toBe(arr);
  });

  it("is a no-op for out-of-range indices", () => {
    const arr = ["a", "b"];
    expect(moveArrayItem(arr, -1, 1)).toBe(arr);
    expect(moveArrayItem(arr, 0, 5)).toBe(arr);
  });
});

describe("moveWithinGroup", () => {
  it("reorders a row among only its own group's members, leaving other groups' rows and absolute slots untouched", () => {
    // grammar rows are a/c/e at absolute slots 0/2/4; move "e" to the front
    // of grammar's own sequence — it should land in grammar's FIRST slot (0),
    // pushing a→2, c→4, while b (slot 1) and d (slot 3) never move.
    const next = moveWithinGroup(rows, categoryOf, "e", 0);
    expect(ids(next)).toEqual(["e", "b", "a", "d", "c"]);
    expect(next[1]).toBe(rows[1]); // b untouched
    expect(next[3]).toBe(rows[3]); // d untouched
  });

  it("moves a row to the end of its group", () => {
    const next = moveWithinGroup(rows, categoryOf, "a", 2);
    expect(ids(next)).toEqual(["c", "b", "e", "d", "a"]);
  });

  it("clamps an out-of-range target to the group's last valid index", () => {
    const next = moveWithinGroup(rows, categoryOf, "a", 99);
    expect(ids(next)).toEqual(["c", "b", "e", "d", "a"]);
  });

  it("is a no-op (same reference) when the id is unknown", () => {
    expect(moveWithinGroup(rows, categoryOf, "nope", 0)).toBe(rows);
  });

  it("is a no-op when the target position doesn't change group order", () => {
    // "a" is already first among grammar rows (a, c, e).
    expect(moveWithinGroup(rows, categoryOf, "a", 0)).toBe(rows);
  });

  it("works on a two-member group (adjacent swap equivalent)", () => {
    const next = moveWithinGroup(rows, categoryOf, "b", 1);
    expect(ids(next)).toEqual(["a", "d", "c", "b", "e"]);
  });
});

describe("moveGroupItemToEdge", () => {
  it("moves a row to the start of its group", () => {
    const next = moveGroupItemToEdge(rows, categoryOf, "e", "start");
    expect(ids(next)).toEqual(["e", "b", "a", "d", "c"]);
  });

  it("moves a row to the end of its group", () => {
    const next = moveGroupItemToEdge(rows, categoryOf, "a", "end");
    expect(ids(next)).toEqual(["c", "b", "e", "d", "a"]);
  });

  it("is a no-op for a row already at that edge", () => {
    expect(moveGroupItemToEdge(rows, categoryOf, "a", "start")).toBe(rows);
  });

  it("is a no-op (same reference) when the id is unknown", () => {
    expect(moveGroupItemToEdge(rows, categoryOf, "nope", "start")).toBe(rows);
  });
});

describe("reassignItemGroup", () => {
  const setGroup = (row: Row, categoryId: string): Row => ({ ...row, categoryId });

  it("moves the row to a new group and appends it to the end of the array", () => {
    const next = reassignItemGroup(rows, "a", "vocab", setGroup);
    expect(ids(next)).toEqual(["b", "c", "d", "e", "a"]);
    expect(next.at(-1)).toEqual({ id: "a", categoryId: "vocab" });
  });

  it("lands last among rows sharing its new group after the reassignment", () => {
    const next = reassignItemGroup(rows, "c", "vocab", setGroup);
    const vocabIds = next.filter((r) => r.categoryId === "vocab").map((r) => r.id);
    expect(vocabIds).toEqual(["b", "d", "c"]);
  });

  it("is a no-op (same reference) when the id is unknown", () => {
    expect(reassignItemGroup(rows, "nope", "vocab", setGroup)).toBe(rows);
  });
});
