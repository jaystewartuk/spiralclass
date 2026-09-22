import { beforeEach, describe, expect, it, vi } from "vitest";

// markTransferPaymentSentAction is the "Ya envié el pago" button. It must always
// end in a redirect (never leave the student stranded): tampered fields →
// home, not-found/wrong-provider → back to the instructions page, and a
// successful mark → the result page, emitting the teacher notifications once.

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const markTransferSent = vi.fn();
vi.mock("@/lib/payments/mark-transfer-sent", () => ({ markTransferSent }));

const emitNotificationQueued = vi.fn(async () => {});
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued }));

const { markTransferPaymentSentAction } = await import("@/app/actions/transfer-mark-sent");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

async function redirectOf(f: FormData): Promise<string> {
  try {
    await markTransferPaymentSentAction(f);
  } catch (err) {
    if (err instanceof RedirectError) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => vi.clearAllMocks());

describe("markTransferPaymentSentAction", () => {
  it("sends tampered (missing) fields home", async () => {
    expect(await redirectOf(fd({ slug: "mira" }))).toBe("/");
    expect(markTransferSent).not.toHaveBeenCalled();
  });

  it("returns to the instructions page when the payment isn't found", async () => {
    markTransferSent.mockResolvedValue({ code: "not-found" });
    expect(await redirectOf(fd({ slug: "mira", ref: "R1" }))).toBe("/b/mira/buy/wise/R1");
  });

  it("emits teacher notifications and redirects to the result page on mark", async () => {
    markTransferSent.mockResolvedValue({
      code: "marked",
      notificationIds: ["n1", "n2"],
      teacherId: "t1",
      externalReference: "ext-9",
    });
    const url = await redirectOf(fd({ slug: "mira", ref: "R1" }));
    expect(url).toBe("/b/mira/buy/result?ref=ext-9");
    expect(emitNotificationQueued).toHaveBeenCalledTimes(2);
    expect(emitNotificationQueued).toHaveBeenCalledWith({ notificationId: "n1", teacherId: "t1" });
  });

  it("redirects to the result page without emitting on an idempotent repeat", async () => {
    markTransferSent.mockResolvedValue({ code: "already", externalReference: "ext-9" });
    const url = await redirectOf(fd({ slug: "mira", ref: "R1" }));
    expect(url).toBe("/b/mira/buy/result?ref=ext-9");
    expect(emitNotificationQueued).not.toHaveBeenCalled();
  });
});
