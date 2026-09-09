import { describe, expect, it } from "vitest";
import {
  isValidTimezone,
  checkoutIntentSchema,
  blockedDateSchema,
  packageTemplateSchema,
  materialStyleSchema,
  resolveVocabulary,
  timezoneSchema,
  DEFAULT_MATERIAL_VOCABULARY,
  MATERIAL_CUSTOM_INSTRUCTIONS_MAX,
  MATERIAL_LANGUAGE_VARIETY_MAX,
} from "./validators";

// The comprehensive per-field coverage lives in apps/web/tests/lib/validators
// (which now exercises this shared module via the re-export). These cases just
// guard that the schemas are self-contained in the shared package — they parse
// without any web-only dependency.

describe("isValidTimezone (shared)", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimezone("America/Mexico_City")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("checkoutIntentSchema (shared)", () => {
  it("normalizes email and accepts a valid intent", () => {
    const parsed = checkoutIntentSchema("es-MX").safeParse({
      slug: "alicia-moreno",
      templateId: "11111111-1111-4111-8111-111111111111",
      studentName: "Mira",
      studentEmail: "  MIRA@example.MX ",
      paymentMethod: "stripe",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.studentEmail).toBe("mira@example.mx");
  });
});

describe("blockedDateSchema (shared)", () => {
  it("rejects an end-before-start range", () => {
    const r = blockedDateSchema("en").safeParse({
      startDate: "2026-06-10",
      endDate: "2026-06-01",
    });
    expect(r.success).toBe(false);
  });
});

describe("packageTemplateSchema — subject (shared)", () => {
  const base = {
    name: "8 clases / 1 mes",
    classCount: 8,
    priceMinorUnits: 10000,
    expirationMonths: 1,
  };

  it("keeps a provided subject", () => {
    const r = packageTemplateSchema.safeParse({ ...base, subject: "Conversation" });
    expect(r.success && r.data.subject).toBe("Conversation");
  });

  it("coerces an empty subject to null", () => {
    const r = packageTemplateSchema.safeParse({ ...base, subject: "" });
    expect(r.success && r.data.subject).toBe(null);
  });

  it("defaults to null when subject is omitted (older payloads)", () => {
    const r = packageTemplateSchema.safeParse(base);
    expect(r.success && r.data.subject).toBe(null);
  });

  it("does not require a subject to keep a valid row", () => {
    const r = packageTemplateSchema.safeParse({ ...base, keep: true });
    expect(r.success).toBe(true);
  });
});

describe("timezoneSchema — targetLanguage (shared, D-112)", () => {
  const base = { timezone: "America/Mexico_City", phoneE164: "5512345678" };

  it("accepts a code from the language registry", () => {
    const r = timezoneSchema("en").safeParse({ ...base, targetLanguage: "fr" });
    expect(r.success && r.data.targetLanguage).toBe("fr");
  });

  it("accepts a curated non-639-1 code — you can teach Nahuatl (D-72)", () => {
    const r = timezoneSchema("en").safeParse({ ...base, targetLanguage: "nah" });
    expect(r.success).toBe(true);
  });

  it("rejects a code outside the registry", () => {
    const r = timezoneSchema("en").safeParse({ ...base, targetLanguage: "zzz" });
    expect(r.success).toBe(false);
  });

  // Optional on the wire on purpose: an already-shipped mobile build predating
  // the field omits it, and a hard schema requirement would 422 that client's
  // whole step 1 instead of just leaving the language unset. The two onboarding
  // forms — and the web server action — are what make it required.
  it("stays optional so a client predating the field still parses", () => {
    const r = timezoneSchema("en").safeParse(base);
    expect(r.success && r.data.targetLanguage).toBeUndefined();
  });
});

describe("resolveVocabulary (shared, D-80)", () => {
  it("the class override replaces the teacher default", () => {
    expect(resolveVocabulary("advanced", "basic")).toBe("advanced");
    expect(resolveVocabulary("basic", "native")).toBe("basic");
  });

  it("falls back to the teacher default when there is no class override", () => {
    expect(resolveVocabulary(null, "advanced")).toBe("advanced");
    expect(resolveVocabulary(undefined, "native")).toBe("native");
  });

  it("falls back to the everyday default when neither is set (level never raises it)", () => {
    expect(resolveVocabulary(null, null)).toBe(DEFAULT_MATERIAL_VOCABULARY);
    expect(resolveVocabulary(undefined, undefined)).toBe("everyday");
  });
});

describe("materialStyleSchema (shared)", () => {
  it("accepts valid presets and free-text, trimming and nulling blanks", () => {
    const r = materialStyleSchema().safeParse({
      tone: "casual",
      learnerAge: "teens",
      languageVariety: "  Mexican Spanish  ",
      customInstructions: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tone).toBe("casual");
      expect(r.data.learnerAge).toBe("teens");
      expect(r.data.languageVariety).toBe("Mexican Spanish");
      expect(r.data.customInstructions).toBeNull();
    }
  });

  it("defaults every field to null when omitted (fully unset is valid)", () => {
    const r = materialStyleSchema().safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({
        tone: null,
        learnerAge: null,
        vocabulary: null,
        languageVariety: null,
        customInstructions: null,
      });
    }
  });

  it("accepts a vocabulary difficulty and coerces blank to null (D-80)", () => {
    const ok = materialStyleSchema().safeParse({ vocabulary: "basic" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.vocabulary).toBe("basic");

    const blank = materialStyleSchema().safeParse({ vocabulary: "" });
    expect(blank.success).toBe(true);
    if (blank.success) expect(blank.data.vocabulary).toBeNull();

    expect(materialStyleSchema().safeParse({ vocabulary: "fluent" }).success).toBe(false);
  });

  it("coerces empty-string enum values to null (web posts '' for 'auto')", () => {
    const r = materialStyleSchema().safeParse({ tone: "", learnerAge: "" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tone).toBeNull();
      expect(r.data.learnerAge).toBeNull();
    }
  });

  it("rejects an unknown tone", () => {
    expect(materialStyleSchema().safeParse({ tone: "sassy" }).success).toBe(false);
  });

  it("rejects over-long free-text fields", () => {
    expect(
      materialStyleSchema().safeParse({
        languageVariety: "x".repeat(MATERIAL_LANGUAGE_VARIETY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      materialStyleSchema().safeParse({
        customInstructions: "x".repeat(MATERIAL_CUSTOM_INSTRUCTIONS_MAX + 1),
      }).success,
    ).toBe(false);
  });
});
