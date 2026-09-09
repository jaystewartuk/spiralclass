import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_MB,
  FEEDBACK_MESSAGE_MIN,
  FEEDBACK_TOPICS,
  attachmentFilename,
  diagnosticsLine,
  hasFeedbackErrors,
  isValidEmail,
  readImageAttachment,
  validateFeedback,
} from "./feedback";

describe("validateFeedback", () => {
  it("rejects a message shorter than the minimum", () => {
    expect(validateFeedback({ message: "broken", email: "" }).message).toBe("feedback.tooShort");
  });

  it("counts the TRIMMED length, so whitespace can't pad a message to the minimum", () => {
    const padded = `hi${" ".repeat(FEEDBACK_MESSAGE_MIN)}`;
    expect(padded.length).toBeGreaterThan(FEEDBACK_MESSAGE_MIN);
    expect(validateFeedback({ message: padded, email: "" }).message).toBe("feedback.tooShort");
  });

  it("accepts a message at exactly the minimum", () => {
    const message = "a".repeat(FEEDBACK_MESSAGE_MIN);
    expect(validateFeedback({ message, email: "" }).message).toBeUndefined();
  });

  it("treats an empty email as valid — an anonymous report is still worth having", () => {
    const errors = validateFeedback({ message: "the buy button does nothing", email: "  " });
    expect(errors.email).toBeUndefined();
    expect(hasFeedbackErrors(errors)).toBe(false);
  });

  it("rejects a non-empty email that isn't plausible", () => {
    const errors = validateFeedback({ message: "the buy button does nothing", email: "mira@" });
    expect(errors.email).toBe("feedback.emailInvalid");
    expect(hasFeedbackErrors(errors)).toBe(true);
  });

  it("reports both problems at once rather than one per submit", () => {
    const errors = validateFeedback({ message: "no", email: "nope" });
    expect(errors.message).toBe("feedback.tooShort");
    expect(errors.email).toBe("feedback.emailInvalid");
  });
});

describe("isValidEmail", () => {
  it.each(["mira@example.com", "mira.luz+tag@sub.example.co.uk", "  mira@example.com  "])(
    "accepts %s",
    (value) => {
      expect(isValidEmail(value)).toBe(true);
    },
  );

  it.each(["", "mira", "mira@", "@example.com", "mira@example", "mira example@x.com"])(
    "rejects %s",
    (value) => {
      expect(isValidEmail(value)).toBe(false);
    },
  );
});

describe("FEEDBACK_TOPICS", () => {
  it("has unique ids — they're the `feedback_topic` tag value in Sentry", () => {
    const ids = FEEDBACK_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every id URL/tag-safe (lowercase, no spaces)", () => {
    for (const topic of FEEDBACK_TOPICS) {
      expect(topic.id).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
  });
});

describe("attachmentFilename", () => {
  it("strips a path component", () => {
    expect(attachmentFilename("C:\\Users\\mira\\shot.png")).toBe("shot.png");
    expect(attachmentFilename("/var/tmp/shot.png")).toBe("shot.png");
  });

  it("falls back for an empty name", () => {
    expect(attachmentFilename("   ")).toBe("screenshot");
  });

  it("caps a very long name", () => {
    expect(attachmentFilename(`${"x".repeat(300)}.png`)).toHaveLength(100);
  });
});

function fileOf({
  name = "shot.png",
  type = "image/png",
  size = 1024,
}: { name?: string; type?: string; size?: number } = {}): File {
  return {
    name,
    type,
    size,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as File;
}

describe("readImageAttachment", () => {
  it("accepts an image and returns bytes Sentry can attach", async () => {
    const result = await readImageAttachment(fileOf());
    expect(result).toMatchObject({ ok: true, filename: "shot.png", contentType: "image/png" });
    if (result.ok) expect(result.data).toBeInstanceOf(Uint8Array);
  });

  it("rejects a non-image", async () => {
    const result = await readImageAttachment(
      fileOf({ name: "notes.pdf", type: "application/pdf" }),
    );
    expect(result).toEqual({ ok: false, error: "feedback.attachInvalidType" });
  });

  it("rejects an image over the size cap, and names the cap for the message", async () => {
    const result = await readImageAttachment(fileOf({ size: ATTACHMENT_MAX_BYTES + 1 }));
    expect(result).toEqual({
      ok: false,
      error: "feedback.attachTooLarge",
      vars: { max: ATTACHMENT_MAX_MB },
    });
  });

  it("accepts an image exactly at the cap", async () => {
    const result = await readImageAttachment(fileOf({ size: ATTACHMENT_MAX_BYTES }));
    expect(result.ok).toBe(true);
  });

  it("reports a read failure instead of throwing into the submit handler", async () => {
    const broken = {
      name: "shot.png",
      type: "image/png",
      size: 10,
      arrayBuffer: async () => {
        throw new Error("nope");
      },
    } as unknown as File;
    expect(await readImageAttachment(broken)).toEqual({
      ok: false,
      error: "feedback.attachReadFailed",
    });
  });
});

describe("diagnosticsLine", () => {
  it("joins what it has", () => {
    expect(
      diagnosticsLine({
        location: { href: "https://spiralclass.com/my-classes" },
        navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14)", language: "es-MX" },
        innerWidth: 393,
        innerHeight: 851,
      }),
    ).toBe(
      "https://spiralclass.com/my-classes · 393x851 · es-MX · Mozilla/5.0 (Linux; Android 14)",
    );
  });

  it("omits what it doesn't have rather than emitting empty separators", () => {
    expect(diagnosticsLine({})).toBe("");
    expect(diagnosticsLine({ navigator: { language: "fr" } })).toBe("fr");
  });
});
