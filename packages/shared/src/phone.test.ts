import { describe, expect, it } from "vitest";
import { normalizeE164, splitE164, whatsAppChatUrl } from "./phone";

describe("normalizeE164", () => {
  it("strips spaces, hyphens, parens and dots", () => {
    expect(normalizeE164("+52 55 1234 5678")).toBe("+525512345678");
    expect(normalizeE164("+52-55-1234-5678")).toBe("+525512345678");
    expect(normalizeE164("+52 (55) 1234.5678")).toBe("+525512345678");
  });

  it("leaves an already-canonical number untouched", () => {
    expect(normalizeE164("+525512345678")).toBe("+525512345678");
  });

  it("keeps a plus-prefixed number's own country code (does not force MX)", () => {
    // A US number the sender explicitly qualified with +1.
    expect(normalizeE164("+1 555 123 4567")).toBe("+15551234567");
  });

  it("prepends + to a number that already leads with the MX country code", () => {
    expect(normalizeE164("525512345678")).toBe("+525512345678");
  });

  // The core regression: a bare, country-code-less MX number must land on +52,
  // not be mis-stamped +55 (Brazil) by a blind "+" prepend.
  it("defaults a bare 10-digit national number to Mexico (+52)", () => {
    expect(normalizeE164("55 1234 5678")).toBe("+525512345678");
    expect(normalizeE164("(55) 1234-5678")).toBe("+525512345678");
    expect(normalizeE164("5512345678")).toBe("+525512345678");
  });

  it("strips the legacy MX trunk/mobile prefixes (044/045/01)", () => {
    expect(normalizeE164("044 55 1234 5678")).toBe("+525512345678");
    expect(normalizeE164("045 55 1234 5678")).toBe("+525512345678");
    expect(normalizeE164("01 55 1234 5678")).toBe("+525512345678");
  });

  it("converts international access prefixes (00/011) to +", () => {
    expect(normalizeE164("0052 55 1234 5678")).toBe("+525512345678");
    expect(normalizeE164("011 1 555 123 4567")).toBe("+15551234567");
  });

  it("still prepends + to an international number typed without one (11+ digits)", () => {
    // A US number entered as 1NXXXXXXXXX — already carries its country code.
    expect(normalizeE164("15551234567")).toBe("+15551234567");
  });

  describe("countryHint", () => {
    it("resolves a bare 10-digit number to the hinted country's calling code", () => {
      expect(normalizeE164("4155550123", "US")).toBe("+14155550123");
      expect(normalizeE164("2012345678", "CA")).toBe("+12012345678");
      expect(normalizeE164("7911123456", "GB")).toBe("+447911123456");
      expect(normalizeE164("1123456789", "AR")).toBe("+541123456789");
    });

    it("still defaults to Mexico when no hint is given (unchanged behavior)", () => {
      expect(normalizeE164("5512345678")).toBe("+525512345678");
    });

    it("falls back to the Mexico default for an unmapped/unknown country hint", () => {
      expect(normalizeE164("5512345678", "ZZ")).toBe("+525512345678");
    });

    it("is case-insensitive on the country hint", () => {
      expect(normalizeE164("4155550123", "us")).toBe("+14155550123");
    });

    it("does not let a hint affect + / 00 / 011-prefixed input", () => {
      expect(normalizeE164("+525512345678", "US")).toBe("+525512345678");
      expect(normalizeE164("0052 55 1234 5678", "US")).toBe("+525512345678");
      expect(normalizeE164("011 1 555 123 4567", "MX")).toBe("+15551234567");
    });

    it("still strips the legacy MX trunk prefix when an explicit MX hint is given", () => {
      expect(normalizeE164("044 55 1234 5678", "MX")).toBe("+525512345678");
    });

    it("recognizes a number that already carries the hinted country's calling code", () => {
      expect(normalizeE164("14155550123", "US")).toBe("+14155550123");
    });

    // The global-readiness regression: most of the world writes its national
    // number with a leading trunk "0" that E.164 does not carry. Before this,
    // a hinted country kept it and minted an invalid number ("+4407700900123").
    it("drops the national trunk zero for a hinted country that uses one", () => {
      expect(normalizeE164("07700 900123", "GB")).toBe("+447700900123");
      expect(normalizeE164("0142868000", "FR")).toBe("+33142868000");
      expect(normalizeE164("0803 123 4567", "NG")).toBe("+2348031234567");
      expect(normalizeE164("098765 43210", "IN")).toBe("+919876543210");
      expect(normalizeE164("082 123 4567", "ZA")).toBe("+27821234567");
    });

    // Italy keeps its leading zero in E.164 — a Roman landline really is
    // "+39 06…" — as do the two states inside its numbering plan.
    it("keeps the leading zero where it is significant (IT/SM/VA)", () => {
      expect(normalizeE164("06 4728 5678", "IT")).toBe("+390647285678");
      expect(normalizeE164("0549 882345", "SM")).toBe("+3780549882345");
    });

    // The bug the MX-only scoping fixes: `^0(44|45|1)` applied to every
    // country ate the "01" area code off a French landline, producing a
    // working number belonging to a stranger.
    it("does not apply the legacy MX trunk strip to another country", () => {
      expect(normalizeE164("01 42 86 80 00", "FR")).toBe("+33142868000");
      expect(normalizeE164("0161 496 0000", "GB")).toBe("+441614960000");
    });

    // A country with no trunk prefix never presents a leading 0, so the strip
    // is a no-op rather than a special case — pinned so it stays that way.
    it("leaves numbers from no-trunk-prefix countries alone", () => {
      expect(normalizeE164("612345678", "ES")).toBe("+34612345678");
      expect(normalizeE164("4155550123", "US")).toBe("+14155550123");
      expect(normalizeE164("5512345678", "MX")).toBe("+525512345678");
    });
  });
});

describe("splitE164", () => {
  // The regression this guards: re-populating a phone field's local-number
  // input straight from a stored E.164 string dumped the whole "+52…" value
  // in, duplicating the country code already shown by the dropdown.
  it("strips the MX calling code, matching the default hint", () => {
    expect(splitE164("+525512345678", "MX")).toEqual({ country: "MX", localNumber: "5512345678" });
  });

  it("strips a hinted country's calling code even without a hint match check needed", () => {
    expect(splitE164("+14155550123", "US")).toEqual({ country: "US", localNumber: "4155550123" });
  });

  it("falls back to matching by calling code when the hint doesn't match the number", () => {
    // A GB student's number saved while the teacher's own default hint is MX.
    expect(splitE164("+447911123456", "MX")).toEqual({ country: "GB", localNumber: "7911123456" });
  });

  it("matches by calling code with no hint at all", () => {
    expect(splitE164("+525512345678")).toEqual({ country: "MX", localNumber: "5512345678" });
  });

  it("round-trips with normalizeE164", () => {
    const cases: Array<[string, string]> = [
      ["5512345678", "MX"],
      ["4155550123", "US"],
      ["7911123456", "GB"],
      ["1123456789", "AR"],
    ];
    for (const [local, country] of cases) {
      const e164 = normalizeE164(local, country);
      expect(splitE164(e164, country)).toEqual({ country, localNumber: local });
    }
  });
});

describe("whatsAppChatUrl", () => {
  it("strips the '+' and builds a bare-digits wa.me link", () => {
    expect(whatsAppChatUrl("+525512345678")).toBe("https://wa.me/525512345678");
  });

  it("strips separators a stored number might carry", () => {
    expect(whatsAppChatUrl("+52 55 1234 5678")).toBe("https://wa.me/525512345678");
  });

  it("appends an encoded prefilled message when given one", () => {
    expect(whatsAppChatUrl("+525512345678", "Hola!")).toBe("https://wa.me/525512345678?text=Hola!");
  });

  it("encodes special characters in the message", () => {
    expect(whatsAppChatUrl("+525512345678", "¿Clases de inglés?")).toBe(
      "https://wa.me/525512345678?text=%C2%BFClases%20de%20ingl%C3%A9s%3F",
    );
  });

  it("returns null for an empty or unparseable number", () => {
    expect(whatsAppChatUrl("")).toBeNull();
    expect(whatsAppChatUrl("not-a-number")).toBeNull();
  });
});
