import { describe, expect, it } from "vitest";
import { resolvePage } from "@/lib/pagination";

describe("resolvePage", () => {
  it("defaults to page 1 with correct skip/range", () => {
    const r = resolvePage({}, 250, 100);
    expect(r).toMatchObject({ page: 1, skip: 0, take: 100, totalPages: 3, from: 1, to: 100 });
  });

  it("computes skip and the trailing range on a middle/last page", () => {
    expect(resolvePage({ page: "2" }, 250, 100)).toMatchObject({ skip: 100, from: 101, to: 200 });
    // Last page is partial: 250 total → rows 201–250.
    expect(resolvePage({ page: "3" }, 250, 100)).toMatchObject({ skip: 200, from: 201, to: 250 });
  });

  it("clamps an over-range page to the last page", () => {
    const r = resolvePage({ page: "9999" }, 250, 100);
    expect(r.page).toBe(3);
    expect(r.skip).toBe(200);
  });

  it("clamps zero/negative/garbage to page 1", () => {
    expect(resolvePage({ page: "0" }, 250, 100).page).toBe(1);
    expect(resolvePage({ page: "-5" }, 250, 100).page).toBe(1);
    expect(resolvePage({ page: "abc" }, 250, 100).page).toBe(1);
  });

  it("reports an empty range and a single page when there are no rows", () => {
    const r = resolvePage({ page: "1" }, 0, 100);
    expect(r).toMatchObject({ page: 1, totalPages: 1, from: 0, to: 0, skip: 0 });
  });
});
