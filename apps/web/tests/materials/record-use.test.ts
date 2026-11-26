import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { isOpenedFor, recordClassMaterialUse, widenOpenedFor } from "@/lib/materials/record-use";

describe("widenOpenedFor", () => {
  it("keeps the audience when a re-open matches it", () => {
    expect(widenOpenedFor("teacher", "teacher")).toBe("teacher");
    expect(widenOpenedFor("both", "both")).toBe("both");
  });

  // Opened once for herself and once for the student means it ended up in
  // front of both, whichever order that happened in.
  it("widens to both when a re-open has a different audience", () => {
    expect(widenOpenedFor("teacher", "student")).toBe("both");
    expect(widenOpenedFor("student", "teacher")).toBe("both");
  });

  it("never narrows an already-both record", () => {
    expect(widenOpenedFor("both", "teacher")).toBe("both");
    expect(widenOpenedFor("both", "student")).toBe("both");
  });
});

describe("isOpenedFor", () => {
  it("accepts the three known audiences", () => {
    expect(isOpenedFor("teacher")).toBe(true);
    expect(isOpenedFor("student")).toBe(true);
    expect(isOpenedFor("both")).toBe(true);
  });

  it("rejects anything else, so a crafted form value falls back", () => {
    expect(isOpenedFor("admin")).toBe(false);
    expect(isOpenedFor("")).toBe(false);
  });
});

it("scopes the update when an existing material opens to more people", async () => {
  const update = vi.fn();
  const db = {
    booking: { findFirst: vi.fn().mockResolvedValue({ id: "b1" }) },
    libraryMaterial: { findFirst: vi.fn().mockResolvedValue({ id: "m1" }) },
    classMaterialUse: {
      findUnique: vi.fn().mockResolvedValue({ id: "use-1", openedFor: "teacher" }),
      update,
    },
  } as unknown as PrismaClient;

  await expect(
    recordClassMaterialUse(
      { teacherId: "t1", bookingId: "b1", materialId: "m1", openedFor: "both" },
      { db },
    ),
  ).resolves.toBe(true);

  expect(update).toHaveBeenCalledWith({
    where: { id: "use-1", teacherId: "t1" },
    data: { openedFor: "both" },
  });
});
