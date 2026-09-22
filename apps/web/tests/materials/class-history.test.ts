import { describe, expect, it } from "vitest";
import {
  kindOfRow,
  mergeHistoryRows,
  rowIsSent,
  type RawHistoryRow,
} from "@/lib/materials/class-history";

function row(overrides: Partial<RawHistoryRow>): RawHistoryRow {
  return {
    materialId: "mat1",
    bookingId: "b1",
    classStart: new Date("2026-07-10T15:00:00Z"),
    label: null,
    storagePath: null,
    linkUrl: null,
    bodyHead: null,
    origin: "class",
    sendTiming: null,
    usedInClass: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("mergeHistoryRows", () => {
  it("collapses the same material in the same class into one row", () => {
    const merged = mergeHistoryRows([
      row({ origin: "library", sendTiming: "t_24h" }),
      row({ origin: "library", usedInClass: true }),
    ]);
    expect(merged).toHaveLength(1);
  });

  // Prepared and used are different facts and a merged row must carry both:
  // the send timing only ever comes from an attachment, the "used" flag only
  // ever from a ClassMaterialUse record.
  it("keeps the attachment's timing and the use record's flag", () => {
    const [m] = mergeHistoryRows([
      row({ origin: "library", sendTiming: "t_24h", label: "Worksheet" }),
      row({ origin: "library", sendTiming: null, usedInClass: true, label: null }),
    ]);
    expect(m.sendTiming).toBe("t_24h");
    expect(m.usedInClass).toBe(true);
    expect(m.label).toBe("Worksheet");
  });

  it("keeps the same material in two different classes as two rows", () => {
    const merged = mergeHistoryRows([
      row({ bookingId: "b1" }),
      row({ bookingId: "b2", classStart: new Date("2026-07-17T15:00:00Z") }),
    ]);
    expect(merged.map((m) => m.bookingId)).toEqual(["b2", "b1"]);
  });

  it("lets a booking-scoped row win the origin over a use record", () => {
    const [m] = mergeHistoryRows([
      row({ origin: "library", usedInClass: true }),
      row({ origin: "class" }),
    ]);
    expect(m.origin).toBe("class");
  });

  it("orders newest class first", () => {
    const merged = mergeHistoryRows([
      row({ bookingId: "old", classStart: new Date("2026-01-01T00:00:00Z") }),
      row({ bookingId: "new", classStart: new Date("2026-08-01T00:00:00Z") }),
      row({ bookingId: "mid", classStart: new Date("2026-04-01T00:00:00Z") }),
    ]);
    expect(merged.map((m) => m.bookingId)).toEqual(["new", "mid", "old"]);
  });

  it("returns nothing for no rows", () => {
    expect(mergeHistoryRows([])).toEqual([]);
  });
});

describe("kindOfRow", () => {
  it("reads a body-only row as native content", () => {
    expect(kindOfRow({ storagePath: null, linkUrl: null, bodyHead: "# Lesson" })).toBe("content");
  });

  it("prefers file over link when a row carries both", () => {
    expect(kindOfRow({ storagePath: "a/b.pdf", linkUrl: "https://x", bodyHead: null })).toBe(
      "file",
    );
  });

  // A content material may also carry a link on the same row (MaterialForm
  // allows it) — the attachment is then the thing to open.
  it("reads a body plus a link as a link", () => {
    expect(kindOfRow({ storagePath: null, linkUrl: "https://x", bodyHead: "# Lesson" })).toBe(
      "link",
    );
  });
});

describe("rowIsSent", () => {
  const classStart = new Date("2026-07-10T15:00:00Z");

  it("gates a scheduled attachment on its send time", () => {
    const r = { origin: "class" as const, sendTiming: "t_1h" as const };
    expect(rowIsSent(r, classStart, new Date("2026-07-10T13:00:00Z"))).toBe(false);
    expect(rowIsSent(r, classStart, new Date("2026-07-10T14:30:00Z"))).toBe(true);
  });

  it("treats an untimed booking-scoped row as always visible", () => {
    expect(
      rowIsSent(
        { origin: "class", sendTiming: null },
        classStart,
        new Date("2026-01-01T00:00:00Z"),
      ),
    ).toBe(true);
  });

  // A library item known only from a use record was never attached, so it is
  // not in the student's class list however long ago the class was.
  it("never counts an unattached library item as sent", () => {
    expect(
      rowIsSent(
        { origin: "library", sendTiming: null },
        classStart,
        new Date("2027-01-01T00:00:00Z"),
      ),
    ).toBe(false);
  });
});
