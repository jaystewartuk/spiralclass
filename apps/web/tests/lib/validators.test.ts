import { describe, expect, it } from "vitest";
import {
  signUpSchema,
  signInSchema,
  timezoneSchema,
  availabilityRangeSchema,
  availabilitySchema,
  blockedDateSchema,
  packageTemplateSchema,
  templatesSchema,
  bookingRequestSchema,
  checkoutIntentSchema,
  leadCaptureSchema,
  wiseInstrumentSchema,
  teacherCreateStudentSchema,
  teacherContactSchema,
  teacherPublicWhatsappSchema,
} from "@/lib/validators";

// Every form in the app parses through one of these schemas. Rejection
// cases here document the contract the actions rely on, so a regression
// in one of the regexes / refines doesn't quietly let bad data through
// to the DB layer.

// Passwordless (2026-06-03): signup is name + email, sign-in is email-only.
describe("signUpSchema", () => {
  it("accepts a valid signup payload", () => {
    expect(
      signUpSchema().safeParse({
        name: "Alicia Moreno",
        email: "mira@example.com",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty name and a malformed email", () => {
    expect(signUpSchema().safeParse({ name: "", email: "x@y.com" }).success).toBe(false);
    expect(signUpSchema().safeParse({ name: "ok", email: "not-an-email" }).success).toBe(false);
  });

  it("rejects names longer than 80 chars", () => {
    expect(
      signUpSchema().safeParse({
        name: "a".repeat(81),
        email: "x@y.com",
      }).success,
    ).toBe(false);
  });
});

describe("signInSchema", () => {
  it("accepts a valid email", () => {
    expect(signInSchema().safeParse({ email: "x@y.com" }).success).toBe(true);
  });
  it("rejects a malformed email", () => {
    expect(signInSchema().safeParse({ email: "not-an-email" }).success).toBe(false);
  });
});

describe("timezoneSchema", () => {
  // A contact phone is required platform-wide for teachers, so every valid parse needs a number.
  const wa = "+5215512345678";

  it("accepts valid IANA timezones", () => {
    expect(
      timezoneSchema().safeParse({ timezone: "America/Mexico_City", phoneE164: wa }).success,
    ).toBe(true);
    expect(timezoneSchema().safeParse({ timezone: "America/Tijuana", phoneE164: wa }).success).toBe(
      true,
    );
    expect(timezoneSchema().safeParse({ timezone: "Europe/London", phoneE164: wa }).success).toBe(
      true,
    );
  });

  it("rejects bogus timezones", () => {
    expect(timezoneSchema().safeParse({ timezone: "Mars/Olympus", phoneE164: wa }).success).toBe(
      false,
    );
    expect(timezoneSchema().safeParse({ timezone: "", phoneE164: wa }).success).toBe(false);
  });

  it("requires a valid E.164 phone number", () => {
    const r1 = timezoneSchema().safeParse({
      timezone: "America/Mexico_City",
      phoneE164: "+5215512345678",
    });
    expect(r1.success).toBe(true);
    if (r1.success) expect(r1.data.phoneE164).toBe("+5215512345678");

    // Empty string is no longer allowed — a contact phone is required.
    expect(
      timezoneSchema().safeParse({ timezone: "America/Mexico_City", phoneE164: "" }).success,
    ).toBe(false);

    // Missing entirely is rejected too.
    expect(timezoneSchema().safeParse({ timezone: "America/Mexico_City" }).success).toBe(false);
  });

  it("rejects malformed phone numbers", () => {
    expect(
      timezoneSchema().safeParse({
        timezone: "America/Mexico_City",
        phoneE164: "abc",
      }).success,
    ).toBe(false);
    expect(
      timezoneSchema().safeParse({
        timezone: "America/Mexico_City",
        phoneE164: "+1", // too short
      }).success,
    ).toBe(false);
  });

  // phoneCountry is independent of `country` — a phone number can carry a
  // different country's calling code than where the teacher's based for
  // payouts, so the schema must accept the two diverging freely.
  it("accepts an optional phoneCountry hint independent of country", () => {
    const r = timezoneSchema().safeParse({
      timezone: "Europe/London",
      phoneE164: wa,
      country: "GB",
      phoneCountry: "US",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.country).toBe("GB");
      expect(r.data.phoneCountry).toBe("US");
    }
  });

  it("coerces an empty phoneCountry to undefined", () => {
    const r = timezoneSchema().safeParse({
      timezone: "America/Mexico_City",
      phoneE164: wa,
      phoneCountry: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phoneCountry).toBeUndefined();
  });
});

describe("availabilityRangeSchema", () => {
  it("accepts a valid range", () => {
    expect(
      availabilityRangeSchema().safeParse({
        weekday: 2,
        startTime: "09:00",
        endTime: "17:00",
      }).success,
    ).toBe(true);
  });

  it("rejects when endTime <= startTime", () => {
    expect(
      availabilityRangeSchema().safeParse({
        weekday: 2,
        startTime: "17:00",
        endTime: "09:00",
      }).success,
    ).toBe(false);
    expect(
      availabilityRangeSchema().safeParse({
        weekday: 2,
        startTime: "10:00",
        endTime: "10:00",
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range weekday and bad HH:MM", () => {
    expect(
      availabilityRangeSchema().safeParse({
        weekday: 7,
        startTime: "09:00",
        endTime: "10:00",
      }).success,
    ).toBe(false);
    expect(
      availabilityRangeSchema().safeParse({
        weekday: 1,
        startTime: "9:00", // missing leading zero
        endTime: "10:00",
      }).success,
    ).toBe(false);
    expect(
      availabilityRangeSchema().safeParse({
        weekday: 1,
        startTime: "25:00",
        endTime: "26:00",
      }).success,
    ).toBe(false);
  });
});

describe("availabilitySchema", () => {
  it("rejects an empty ranges array", () => {
    expect(
      availabilitySchema().safeParse({
        bufferMin: 10,
        minAdvanceH: 2,
        maxAdvanceDays: 60,
        ranges: [],
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-bounds buffer / advance values", () => {
    const range = { weekday: 1, startTime: "09:00", endTime: "10:00" };
    expect(
      availabilitySchema().safeParse({
        bufferMin: 121,
        minAdvanceH: 2,
        maxAdvanceDays: 60,
        ranges: [range],
      }).success,
    ).toBe(false);
    expect(
      availabilitySchema().safeParse({
        bufferMin: 10,
        minAdvanceH: 169,
        maxAdvanceDays: 60,
        ranges: [range],
      }).success,
    ).toBe(false);
    expect(
      availabilitySchema().safeParse({
        bufferMin: 10,
        minAdvanceH: 2,
        maxAdvanceDays: 0,
        ranges: [range],
      }).success,
    ).toBe(false);
  });

  const base = { bufferMin: 10, minAdvanceH: 2, maxAdvanceDays: 60 };

  it("rejects two overlapping ranges on the same day", () => {
    const parsed = availabilitySchema().safeParse({
      ...base,
      ranges: [
        { weekday: 5, startTime: "09:00", endTime: "11:00" },
        { weekday: 5, startTime: "10:00", endTime: "12:00" },
      ],
    });
    expect(parsed.success).toBe(false);
    // Points at the later-starting (second) range, not the first.
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(["ranges", 1]);
    }
  });

  it("allows two ranges that only touch at an endpoint (09–10, 10–11)", () => {
    expect(
      availabilitySchema().safeParse({
        ...base,
        ranges: [
          { weekday: 5, startTime: "09:00", endTime: "10:00" },
          { weekday: 5, startTime: "10:00", endTime: "11:00" },
        ],
      }).success,
    ).toBe(true);
  });

  it("allows overlapping-looking ranges when they're on different days", () => {
    expect(
      availabilitySchema().safeParse({
        ...base,
        ranges: [
          { weekday: 1, startTime: "09:00", endTime: "11:00" },
          { weekday: 2, startTime: "10:00", endTime: "12:00" },
        ],
      }).success,
    ).toBe(true);
  });

  it("detects overlap regardless of the order the ranges are submitted", () => {
    expect(
      availabilitySchema().safeParse({
        ...base,
        ranges: [
          { weekday: 3, startTime: "14:00", endTime: "16:00" },
          { weekday: 3, startTime: "09:00", endTime: "15:00" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("blockedDateSchema", () => {
  it("accepts a same-day block (startDate === endDate)", () => {
    expect(
      blockedDateSchema().safeParse({
        startDate: "2026-12-25",
        endDate: "2026-12-25",
      }).success,
    ).toBe(true);
  });

  it("rejects when endDate < startDate", () => {
    expect(
      blockedDateSchema().safeParse({
        startDate: "2026-12-30",
        endDate: "2026-12-29",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed YYYY-MM-DD", () => {
    expect(
      blockedDateSchema().safeParse({
        startDate: "12/25/2026",
        endDate: "12/26/2026",
      }).success,
    ).toBe(false);
  });

  it("rejects reasons longer than 120 chars", () => {
    expect(
      blockedDateSchema().safeParse({
        startDate: "2026-01-01",
        endDate: "2026-01-01",
        reason: "x".repeat(121),
      }).success,
    ).toBe(false);
  });
});

describe("packageTemplateSchema + templatesSchema", () => {
  it("accepts a well-formed template", () => {
    expect(
      packageTemplateSchema.safeParse({
        name: "Plan",
        classCount: 4,
        priceMinorUnits: 100_000,
        expirationMonths: 1,
      }).success,
    ).toBe(true);
  });

  it("rejects negative priceMinorUnits and non-positive classCount (tenant isolation invariant)", () => {
    expect(
      packageTemplateSchema.safeParse({
        name: "x",
        classCount: 0,
        priceMinorUnits: 100,
        expirationMonths: 1,
      }).success,
    ).toBe(false);
    expect(
      packageTemplateSchema.safeParse({
        name: "x",
        classCount: 4,
        priceMinorUnits: -1,
        expirationMonths: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects templates without an expirationMonths (package templates invariant)", () => {
    expect(
      packageTemplateSchema.safeParse({
        name: "Plan",
        classCount: 4,
        priceMinorUnits: 100_000,
      }).success,
    ).toBe(false);
  });

  it("defaults classDurationMin to 50 and keep to true", () => {
    const r = packageTemplateSchema.safeParse({
      name: "Plan",
      classCount: 4,
      priceMinorUnits: 100_000,
      expirationMonths: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.classDurationMin).toBe(50);
      expect(r.data.keep).toBe(true);
    }
  });

  it("defaults singleClass to false", () => {
    const r = packageTemplateSchema.safeParse({
      name: "Plan",
      classCount: 4,
      priceMinorUnits: 100_000,
      expirationMonths: 1,
    });
    expect(r.success && r.data.singleClass).toBe(false);
  });

  it("pins classCount to 1 when singleClass is set, ignoring a stray value", () => {
    const r = packageTemplateSchema.safeParse({
      name: "1 clase",
      singleClass: true,
      classCount: 5, // tampered/stale — must not be honored
      priceMinorUnits: 50_000,
      expirationMonths: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.singleClass).toBe(true);
      expect(r.data.classCount).toBe(1);
    }
  });

  it("templatesSchema accepts an empty array (allows fully-archived state)", () => {
    expect(templatesSchema.safeParse({ templates: [] }).success).toBe(true);
  });

  it("skips content validation for an unkept (removed) row — the reported bug", () => {
    // A blank row the teacher added and then removed: empty name, zero/negative
    // numbers, no expiration. With keep=false none of this may block the submit.
    expect(
      packageTemplateSchema.safeParse({
        name: "",
        classCount: 0,
        priceMinorUnits: -100,
        expirationMonths: null,
        keep: false,
      }).success,
    ).toBe(true);
  });

  it("still validates content when keep is true", () => {
    expect(
      packageTemplateSchema.safeParse({
        name: "",
        classCount: 4,
        priceMinorUnits: 100_000,
        expirationMonths: 1,
        keep: true,
      }).success,
    ).toBe(false);
  });
});

describe("bookingRequestSchema", () => {
  it("bookingRequestSchema requires uuid packageId and ISO datetime startUtc", () => {
    expect(
      bookingRequestSchema.safeParse({
        packageId: "44444444-4444-4444-8444-444444444444",
        startUtc: "2026-04-15T16:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      bookingRequestSchema.safeParse({
        packageId: "not-a-uuid",
        startUtc: "2026-04-15T16:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      bookingRequestSchema.safeParse({
        packageId: "44444444-4444-4444-8444-444444444444",
        startUtc: "2026-04-15 16:00", // not ISO
      }).success,
    ).toBe(false);
  });
});

describe("checkoutIntentSchema", () => {
  const base = {
    slug: "alicia-moreno",
    templateId: "44444444-4444-4444-8444-444444444444",
    studentName: "Marco",
    studentEmail: "marco@example.com",
  };

  it("accepts a checkout with a contact phone", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      studentPhone: "+5215512345678",
    });
    expect(r.success).toBe(true);
  });

  it("accepts an intended slot (single-class pay-at-reservation)", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      intendedStartUtc: "2026-07-01T17:00:00.000Z",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.intendedStartUtc).toBe("2026-07-01T17:00:00.000Z");
  });

  it("treats an empty intended slot as absent (ordinary package buy)", () => {
    const r = checkoutIntentSchema().safeParse({ ...base, intendedStartUtc: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.intendedStartUtc).toBeUndefined();
  });

  it("rejects a malformed intended slot", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      intendedStartUtc: "next tuesday",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a checkout without a phone (email-only path)", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      studentPhone: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.studentPhone).toBeUndefined();
  });

  it("strips spaces/separators from a pasted number", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      studentPhone: "+1 555 123 4567",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.studentPhone).toBe("+15551234567");
  });

  it("rejects malformed phone numbers", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      studentPhone: "abc",
    });
    expect(r.success).toBe(false);
  });

  it("defaults paymentMethod to stripe so existing call sites keep working", () => {
    const r = checkoutIntentSchema().safeParse({ ...base, studentPhone: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.paymentMethod).toBe("stripe");
  });

  it("accepts paymentMethod=manual_transfer with an instrument id", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      studentPhone: "",
      paymentMethod: "manual_transfer",
      instrumentId: "11111111-1111-1111-1111-111111111111",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.paymentMethod).toBe("manual_transfer");
      expect(r.data.instrumentId).toBe("11111111-1111-1111-1111-111111111111");
    }
  });

  // Regression: `FormData.get()` returns null for a field the form did not
  // include, and the first cut only coerced the empty string — so every Stripe
  // checkout from a form without the hidden input failed validation with
  // "Expected string, received null".
  it("treats an absent instrumentId as undefined, not as a null string", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      studentPhone: "",
      paymentMethod: "stripe",
      instrumentId: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.instrumentId).toBeUndefined();
  });

  // The hidden input is always present in the form, so Stripe submits it as
  // an empty string rather than omitting it.
  it("coerces an empty instrumentId to undefined (the Stripe rail's hidden input)", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      studentPhone: "",
      paymentMethod: "stripe",
      instrumentId: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.instrumentId).toBeUndefined();
  });

  it("rejects an unknown paymentMethod", () => {
    const r = checkoutIntentSchema().safeParse({
      ...base,
      studentPhone: "",
      paymentMethod: "paypal",
    });
    expect(r.success).toBe(false);
  });
});

describe("packageTemplateSchema — Wise price column", () => {
  it("accepts an optional transferPriceMinorUnits override", () => {
    const r = packageTemplateSchema.safeParse({
      name: "Plan",
      classCount: 4,
      priceMinorUnits: 240_000,
      transferPriceMinorUnits: 232_000,
      expirationMonths: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.transferPriceMinorUnits).toBe(232_000);
  });

  it("treats an empty string as undefined (form-friendly)", () => {
    const r = packageTemplateSchema.safeParse({
      name: "Plan",
      classCount: 4,
      priceMinorUnits: 240_000,
      transferPriceMinorUnits: "",
      expirationMonths: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.transferPriceMinorUnits).toBeUndefined();
  });

  it("rejects a negative transferPriceMinorUnits", () => {
    const r = packageTemplateSchema.safeParse({
      name: "Plan",
      classCount: 4,
      priceMinorUnits: 240_000,
      transferPriceMinorUnits: -1,
      expirationMonths: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe("wiseInstrumentSchema", () => {
  it("accepts a fully-empty payload (teacher saving a blank state)", () => {
    expect(wiseInstrumentSchema().safeParse({}).success).toBe(true);
  });

  it("accepts enable + handle on file", () => {
    const r = wiseInstrumentSchema().safeParse({
      enabled: true,
      handle: "anal3829",
      accountHolder: "Alicia Moreno",
      email: "mira@x.com",
    });
    expect(r.success).toBe(true);
  });

  // Regression: the pre-D-113 version of this test fed a `clabe` key into the
  // Wise schema and asserted only `success`. Zod strips unknown keys, so it
  // passed while proving nothing — and read as CLABE support that did not
  // exist anywhere in the product. Bank details belong to the bank_account
  // instrument; the Wise schema must not carry them through.
  it("does not carry bank details through — those belong to the bank instrument", () => {
    const r = wiseInstrumentSchema().safeParse({
      enabled: true,
      handle: "anal3829",
      schemeId: "mx_clabe",
      details: { clabe: "002010077777777771" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect("details" in r.data).toBe(false);
      expect("schemeId" in r.data).toBe(false);
    }
  });

  it("rejects enable without a handle", () => {
    const r = wiseInstrumentSchema().safeParse({ enabled: true, handle: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const err = r.error.issues.find((i) => i.path[0] === "handle");
      expect(err).toBeTruthy();
    }
  });

  it("rejects handles with invalid chars (e.g. a pasted URL)", () => {
    const r = wiseInstrumentSchema().safeParse({
      enabled: true,
      handle: "https://wise.com/pay/anal3829",
    });
    expect(r.success).toBe(false);
  });

  it("coerces empty fields to undefined so the action writes nulls", () => {
    const r = wiseInstrumentSchema().safeParse({
      enabled: false,
      handle: "",
      accountHolder: "",
      email: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.handle).toBeUndefined();
      expect(r.data.accountHolder).toBeUndefined();
      expect(r.data.email).toBeUndefined();
    }
  });
});

describe("leadCaptureSchema", () => {
  it("accepts a minimal valid lead (name + email only)", () => {
    const r = leadCaptureSchema().safeParse({
      slug: "alicia-moreno",
      name: "Sofía",
      email: "Sofia@Example.com",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // Identity emails are trimmed + lowercased at the boundary.
      expect(r.data.email).toBe("sofia@example.com");
      expect(r.data.phone).toBeUndefined();
      expect(r.data.message).toBeUndefined();
    }
  });

  it("accepts an optional contact phone", () => {
    const r = leadCaptureSchema().safeParse({
      slug: "alicia-moreno",
      name: "Sofía",
      email: "sofia@example.com",
      phone: "+52 55 1234 5678",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const r = leadCaptureSchema().safeParse({
      slug: "alicia-moreno",
      name: "",
      email: "sofia@example.com",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const r = leadCaptureSchema().safeParse({
      slug: "alicia-moreno",
      name: "Sofía",
      email: "not-an-email",
    });
    expect(r.success).toBe(false);
  });

  it("coerces an empty message to undefined", () => {
    const r = leadCaptureSchema().safeParse({
      slug: "alicia-moreno",
      name: "Sofía",
      email: "sofia@example.com",
      message: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.message).toBeUndefined();
  });

  it("accepts an optional phoneCountry hint", () => {
    const r = leadCaptureSchema().safeParse({
      slug: "alicia-moreno",
      name: "Sofía",
      email: "sofia@example.com",
      phone: "55 1234 5678",
      phoneCountry: "US",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phoneCountry).toBe("US");
  });

  it("coerces an empty phoneCountry to undefined", () => {
    const r = leadCaptureSchema().safeParse({
      slug: "alicia-moreno",
      name: "Sofía",
      email: "sofia@example.com",
      phoneCountry: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phoneCountry).toBeUndefined();
  });
});

// Teacher staging a student by hand (silent onboarding). Mirrors
// teacherEditStudentContactSchema's phoneCountry hint — the createStudentAction
// bug (writing the raw phone with no normalizeE164 call at all) is fixed by
// wiring this field through, same as every other contact surface.
describe("teacherCreateStudentSchema", () => {
  it("accepts a minimal valid student (name only)", () => {
    const r = teacherCreateStudentSchema().safeParse({ name: "Sofía" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.phone).toBeUndefined();
      expect(r.data.phoneCountry).toBeUndefined();
    }
  });

  it("accepts an optional phoneCountry hint alongside the phone", () => {
    const r = teacherCreateStudentSchema().safeParse({
      name: "Sofía",
      phone: "55 1234 5678",
      phoneCountry: "US",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phoneCountry).toBe("US");
  });

  it("coerces an empty phoneCountry to undefined", () => {
    const r = teacherCreateStudentSchema().safeParse({
      name: "Sofía",
      phoneCountry: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phoneCountry).toBeUndefined();
  });

  it("rejects a missing name", () => {
    const r = teacherCreateStudentSchema().safeParse({ name: "" });
    expect(r.success).toBe(false);
  });
});

// Teacher self-service contact edit (account page). phoneCountry is
// independent of the teacher's payout country (a separate action/form) — a
// phone number can carry a different country's calling code than where
// she's based for payouts, so the schema must accept the two diverging.
describe("teacherContactSchema", () => {
  it("accepts a minimal valid contact (name only)", () => {
    const r = teacherContactSchema().safeParse({ name: "Mira" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.phone).toBeUndefined();
      expect(r.data.phoneCountry).toBeUndefined();
    }
  });

  it("accepts an optional phoneCountry hint alongside the phone", () => {
    const r = teacherContactSchema().safeParse({
      name: "Mira",
      phone: "4155550123",
      phoneCountry: "US",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phoneCountry).toBe("US");
  });

  it("coerces an empty phoneCountry to undefined", () => {
    const r = teacherContactSchema().safeParse({ name: "Mira", phoneCountry: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phoneCountry).toBeUndefined();
  });

  it("rejects a missing name", () => {
    const r = teacherContactSchema().safeParse({ name: "" });
    expect(r.success).toBe(false);
  });
});

// Separate schema from teacherContactSchema above — this one edits the
// PUBLIC-facing publicWhatsappE164 field (opt-in, shown on /b/<slug>), not
// the private account phone. See schema.prisma's Teacher.publicWhatsappE164.
describe("teacherPublicWhatsappSchema", () => {
  it("accepts an empty payload (no number set)", () => {
    const r = teacherPublicWhatsappSchema().safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.whatsapp).toBeUndefined();
      expect(r.data.whatsappCountry).toBeUndefined();
    }
  });

  it("accepts a valid number with a country hint", () => {
    const r = teacherPublicWhatsappSchema().safeParse({
      whatsapp: "55 1234 5678",
      whatsappCountry: "MX",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.whatsapp).toBe("5512345678");
      expect(r.data.whatsappCountry).toBe("MX");
    }
  });

  it("coerces an empty whatsappCountry to undefined", () => {
    const r = teacherPublicWhatsappSchema().safeParse({ whatsappCountry: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.whatsappCountry).toBeUndefined();
  });

  it("rejects a malformed number", () => {
    const r = teacherPublicWhatsappSchema().safeParse({ whatsapp: "not-a-number" });
    expect(r.success).toBe(false);
  });
});
