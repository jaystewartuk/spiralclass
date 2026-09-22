import { describe, expect, it } from "vitest";
import { resolveSort, type SortColumns } from "@/lib/table-sort";

// The admin tables hand `resolveSort`'s output straight to Prisma `orderBy`,
// so the column whitelist is the boundary that stops a crafted `?sort=` from
// ordering by an arbitrary (or non-existent) field.

const columns: SortColumns<{ field: string; direction: string }> = {
  name: (dir) => ({ field: "name", direction: dir }),
  created: (dir) => ({ field: "createdAt", direction: dir }),
};

describe("resolveSort", () => {
  it("falls back to the default column + direction when nothing is supplied", () => {
    const { state, orderBy } = resolveSort({}, columns, "created");
    expect(state).toEqual({ key: "created", dir: "desc" });
    expect(orderBy).toEqual({ field: "createdAt", direction: "desc" });
  });

  it("honours an allowed column and explicit direction", () => {
    const { state, orderBy } = resolveSort({ sort: "name", dir: "asc" }, columns, "created");
    expect(state).toEqual({ key: "name", dir: "asc" });
    expect(orderBy).toEqual({ field: "name", direction: "asc" });
  });

  it("ignores a column outside the whitelist (no arbitrary orderBy)", () => {
    const { state, orderBy } = resolveSort(
      { sort: "password; DROP TABLE", dir: "asc" },
      columns,
      "created",
    );
    expect(state.key).toBe("created");
    // Direction is still respected so the fallback column can flip.
    expect(orderBy).toEqual({ field: "createdAt", direction: "asc" });
  });

  it("does not treat inherited Object properties as valid columns", () => {
    const { state } = resolveSort({ sort: "toString" }, columns, "created");
    expect(state.key).toBe("created");
  });

  it("coerces an invalid direction to the fallback direction", () => {
    const { state } = resolveSort({ sort: "name", dir: "sideways" }, columns, "created", "asc");
    expect(state).toEqual({ key: "name", dir: "asc" });
  });
});
