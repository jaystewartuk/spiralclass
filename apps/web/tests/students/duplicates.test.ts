import { describe, expect, it } from "vitest";
import { findRosterDuplicates, type RosterDuplicateCandidate } from "@/lib/students/duplicates";

const entry = (
  studentId: string,
  email: string | null,
  phoneE164: string | null = null,
): RosterDuplicateCandidate => ({ studentId, email, phoneE164 });

describe("findRosterDuplicates", () => {
  it("flags identical normalized emails (legacy mixed-case rows)", () => {
    const pairs = findRosterDuplicates([
      entry("a", "Mira@Gmail.com"),
      entry("b", "mira@gmail.com"),
    ]);
    expect(pairs).toEqual([{ aId: "a", bId: "b", reason: "same_email" }]);
  });

  it("flags a shared phone number", () => {
    const pairs = findRosterDuplicates([
      entry("a", "mira@gmail.com", "+5215555000001"),
      entry("b", "mira@empresa.mx", "+5215555000001"),
    ]);
    expect(pairs).toEqual([{ aId: "a", bId: "b", reason: "same_phone" }]);
  });

  it("flags the same local part with a near-miss domain (the observed typo case)", () => {
    const pairs = findRosterDuplicates([
      entry("a", "test_student_1@spiralclass.com"),
      entry("b", "test_student_1@spiralclas.com"),
    ]);
    expect(pairs).toEqual([{ aId: "a", bId: "b", reason: "similar_email" }]);
  });

  it("does not pair distinct people", () => {
    const pairs = findRosterDuplicates([
      entry("a", "maria@gmail.com", "+5215555000001"),
      entry("b", "carlos@gmail.com", "+5215555000002"),
      entry("c", null, null),
      entry("d", null, null),
    ]);
    expect(pairs).toEqual([]);
  });

  it("does not pair the same local part on unrelated domains", () => {
    const pairs = findRosterDuplicates([
      entry("a", "info@gmail.com"),
      entry("b", "info@hotmail.com"),
    ]);
    expect(pairs).toEqual([]);
  });

  it("uses each student in at most one pair", () => {
    const pairs = findRosterDuplicates([
      entry("a", "mira@gmial.com", "+521"),
      entry("b", "mira@gmial.com", "+521"),
      entry("c", "mira@gmial.com", "+521"),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ aId: "a", bId: "b", reason: "same_email" });
  });
});
