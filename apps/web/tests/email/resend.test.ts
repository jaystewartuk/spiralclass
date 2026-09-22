import { describe, expect, it, vi } from "vitest";
import { createStubEmailClient, fetchResendClient } from "@/lib/email/resend";

// Every failure the Resend client can return carries a `code` — the
// low-cardinality classification a caller reports to Sentry, because the
// free-text `error` lands in `extra` and gets scrubbed to "[Filtered]" there
// (AGENDAPROFE-1V: seven weeks of "send failed" with no cause attached).

function client(fetchImpl: typeof fetch) {
  return fetchResendClient({
    apiKey: "re_test",
    fromAddress: "SpiralClass <no-reply@updates.spiralclass.com>",
    fetchImpl,
  });
}

function send(fetchImpl: typeof fetch) {
  return client(fetchImpl).send({
    to: "student@example.com",
    subject: "Hi",
    body: "plain body",
  });
}

describe("fetchResendClient", () => {
  it("returns the provider message id on success", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "resend-msg-1" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(send(fetchImpl)).resolves.toEqual({
      ok: true,
      providerMessageId: "resend-msg-1",
    });
  });

  // The production failure this coverage exists for: Resend refuses the send
  // outright (unverified sending domain, or an API key scoped to a different
  // one). Non-retryable, and the status is the whole diagnosis.
  it("classifies a 403 as resend-403 and does not mark it retryable", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ statusCode: 403, name: "validation_error", message: "not verified" }),
          { status: 403 },
        ),
    ) as unknown as typeof fetch;

    const result = await send(fetchImpl);

    expect(result).toMatchObject({ ok: false, code: "resend-403", retryable: false });
    expect(result).toMatchObject({ error: expect.stringContaining("not verified") });
  });

  it("marks 5xx and 429 retryable, keeping the status in the code", async () => {
    const serverError = vi.fn(
      async () => new Response("upstream down", { status: 503 }),
    ) as unknown as typeof fetch;
    const rateLimited = vi.fn(
      async () => new Response("slow down", { status: 429 }),
    ) as unknown as typeof fetch;

    expect(await send(serverError)).toMatchObject({ code: "resend-503", retryable: true });
    expect(await send(rateLimited)).toMatchObject({ code: "resend-429", retryable: true });
  });

  it("classifies a transport failure as network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    expect(await send(fetchImpl)).toEqual({
      ok: false,
      error: "network: boom",
      code: "network",
      retryable: true,
    });
  });

  it("classifies a 200 with no id, and an unparseable 200, distinctly", async () => {
    const noId = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    const garbage = vi.fn(
      async () => new Response("<html>nope</html>", { status: 200 }),
    ) as unknown as typeof fetch;

    expect(await send(noId)).toMatchObject({ ok: false, code: "missing-id", retryable: false });
    expect(await send(garbage)).toMatchObject({
      ok: false,
      code: "unparseable",
      retryable: false,
    });
  });
});

describe("createStubEmailClient", () => {
  it("carries a code on a queued failure, defaulting to stub", async () => {
    const stub = createStubEmailClient();

    stub.failNext("boom", false);
    expect(await stub.send({ to: "a@example.com", subject: "s", body: "b" })).toEqual({
      ok: false,
      error: "boom",
      code: "stub",
      retryable: false,
    });

    stub.failNext("boom", true, "resend-403");
    expect(await stub.send({ to: "a@example.com", subject: "s", body: "b" })).toMatchObject({
      code: "resend-403",
    });
  });
});
