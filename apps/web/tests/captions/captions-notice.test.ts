import { describe, expect, it } from "vitest";
import {
  CAPTIONS_NOTICE_STORAGE_KEY,
  LEGACY_CAPTIONS_NOTICE_STORAGE_KEY,
  parseCaptionsNoticeSeen,
} from "@/lib/captions/notice";

// The flag's whole job is to show a privacy explanation ONCE. Renaming its
// storage key from the pre-D-138 brand without reading the old one would
// re-show a dismissed notice to every browser that had already dismissed it —
// the exact class of loss D-138 avoided by leaving the mobile storage keys
// alone. This is that rename, done without the loss.

describe("parseCaptionsNoticeSeen", () => {
  it("is not seen on a browser that has neither key", () => {
    expect(parseCaptionsNoticeSeen(null, null)).toBe(false);
  });

  it("is seen from the current key alone", () => {
    expect(parseCaptionsNoticeSeen("1", null)).toBe(true);
  });

  it("is seen from the pre-D-138 key alone", () => {
    // The regression this file exists for: a browser that dismissed the notice
    // before the rename carries ONLY the old key, and must not be asked again.
    expect(parseCaptionsNoticeSeen(null, "1")).toBe(true);
  });

  it("is seen when a browser mid-migration carries both", () => {
    expect(parseCaptionsNoticeSeen("1", "1")).toBe(true);
  });

  it("treats any value other than the written one as not seen", () => {
    // Storage is writable by any earlier build and by the reader's devtools.
    // Anything unrecognised degrades to showing the notice, which is the safe
    // direction for a privacy disclosure.
    for (const junk of ["", "0", "true", "yes", "{}"]) {
      expect(parseCaptionsNoticeSeen(junk, junk)).toBe(false);
    }
  });

  it("keeps the two keys distinct, and only the current one carries the new brand", () => {
    expect(CAPTIONS_NOTICE_STORAGE_KEY).toBe("spiralclass.captionsNoticeSeen");
    expect(LEGACY_CAPTIONS_NOTICE_STORAGE_KEY).toBe("agendaprofe.captionsNoticeSeen");
    expect(CAPTIONS_NOTICE_STORAGE_KEY).not.toBe(LEGACY_CAPTIONS_NOTICE_STORAGE_KEY);
  });
});
