import { describe, expect, it } from "vitest";
import { includedItemsFor, type BookingPageCapabilities } from "./booking-page";

const OFF: BookingPageCapabilities = {
  liveCaptions: false,
  progressSharing: false,
};
const ALL: BookingPageCapabilities = {
  liveCaptions: true,
  progressSharing: true,
};

describe("includedItemsFor", () => {
  it("always renders the seven ungated promises, differentiation first", () => {
    expect(includedItemsFor(OFF)).toEqual([
      "continuity",
      "materials",
      "homework",
      "video",
      "reschedule",
      "reminders",
      "messages",
    ]);
  });

  it("drops a gated item entirely when its capability is off", () => {
    const items = includedItemsFor(OFF);
    expect(items).not.toContain("captions");
    expect(items).not.toContain("vocabulary");
  });

  it("slots captions directly after the continuity line it reinforces", () => {
    const items = includedItemsFor({ ...OFF, liveCaptions: true });
    expect(items.indexOf("captions")).toBe(items.indexOf("continuity") + 1);
  });

  it("slots the vocabulary review directly after homework", () => {
    const items = includedItemsFor({ ...OFF, progressSharing: true });
    expect(items.indexOf("vocabulary")).toBe(items.indexOf("homework") + 1);
  });

  it("promises the vocabulary review only when the teacher shares progress", () => {
    // The line is gated on her own setting rather than a platform flag, because
    // nothing platform-side decides it — a student sees the queue only if she
    // shares their learning profile.
    expect(includedItemsFor({ ...OFF, progressSharing: false })).not.toContain("vocabulary");
    expect(includedItemsFor({ ...OFF, progressSharing: true })).toContain("vocabulary");
  });

  it("keeps both gated items anchored to the lines they reinforce", () => {
    // Regression guard on the splices: each indexes off its anchor item rather
    // than a fixed position, so one landing must not displace the other.
    const items = includedItemsFor(ALL);
    expect(items).toEqual([
      "continuity",
      "captions",
      "materials",
      "homework",
      "vocabulary",
      "video",
      "reschedule",
      "reminders",
      "messages",
    ]);
  });

  it("never repeats an item", () => {
    const items = includedItemsFor(ALL);
    expect(new Set(items).size).toBe(items.length);
  });
});
