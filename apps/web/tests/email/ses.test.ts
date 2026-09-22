import { describe, expect, it, vi } from "vitest";
import { fetchSesClient } from "@/lib/email/ses";

function client(fetchImpl: typeof fetch) {
  return fetchSesClient({
    region: "us-east-1",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "secret",
    fromAddress: "SpiralClass <no-reply@updates.spiralclass.com>",
    fetchImpl,
  });
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchSesClient", () => {
  it("signs and posts to the SESv2 outbound-emails endpoint, returning the MessageId", async () => {
    let capturedRequest: Request | null = null;
    const fetchImpl = vi.fn(async (input: Request) => {
      capturedRequest = input;
      return jsonResponse(200, { MessageId: "ses-msg-123" });
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).send({
      to: "student@example.com",
      subject: "Hi",
      body: "plain body",
    });

    expect(result).toEqual({ ok: true, providerMessageId: "ses-msg-123" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const req = capturedRequest!;
    expect(req.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    expect(req.method).toBe("POST");
    // Signed by aws4fetch — a real signature, not just a bearer token.
    expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);

    const body = JSON.parse(await req.clone().text()) as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      Content: { Raw: { Data: string } };
    };
    expect(body.FromEmailAddress).toBe("SpiralClass <no-reply@updates.spiralclass.com>");
    expect(body.Destination.ToAddresses).toEqual(["student@example.com"]);
    const raw = Buffer.from(body.Content.Raw.Data, "base64").toString("utf-8");
    expect(raw).toContain("To: student@example.com");
    expect(raw).toContain("Subject: Hi");
    expect(raw).toContain("plain body");
  });

  it("builds a multipart/alternative message when html is provided", async () => {
    let capturedRequest: Request | null = null;
    const fetchImpl = vi.fn(async (input: Request) => {
      capturedRequest = input;
      return jsonResponse(200, { MessageId: "ses-msg-456" });
    }) as unknown as typeof fetch;

    await client(fetchImpl).send({
      to: "student@example.com",
      subject: "Hi",
      body: "plain body",
      html: "<p>html body</p>",
    });

    const body = JSON.parse(await capturedRequest!.clone().text()) as {
      Content: { Raw: { Data: string } };
    };
    const raw = Buffer.from(body.Content.Raw.Data, "base64").toString("utf-8");
    expect(raw).toContain("Content-Type: multipart/alternative");
    expect(raw).toContain("plain body");
    expect(raw).toContain("<p>html body</p>");
  });

  it("carries replyTo and custom headers (e.g. List-Unsubscribe) into the raw MIME message", async () => {
    let capturedRequest: Request | null = null;
    const fetchImpl = vi.fn(async (input: Request) => {
      capturedRequest = input;
      return jsonResponse(200, { MessageId: "ses-msg-789" });
    }) as unknown as typeof fetch;

    await client(fetchImpl).send({
      to: "student@example.com",
      subject: "Hi",
      body: "plain body",
      replyTo: "support@spiralclass.com",
      headers: {
        "List-Unsubscribe": "<https://spiralclass.com/unsub>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    const body = JSON.parse(await capturedRequest!.clone().text()) as {
      Content: { Raw: { Data: string } };
    };
    const raw = Buffer.from(body.Content.Raw.Data, "base64").toString("utf-8");
    expect(raw).toContain("Reply-To: support@spiralclass.com");
    expect(raw).toContain("List-Unsubscribe: <https://spiralclass.com/unsub>");
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("strips CR/LF from header-bound fields to prevent MIME header injection", async () => {
    let capturedRequest: Request | null = null;
    const fetchImpl = vi.fn(async (input: Request) => {
      capturedRequest = input;
      return jsonResponse(200, { MessageId: "x" });
    }) as unknown as typeof fetch;

    await client(fetchImpl).send({
      to: "student@example.com",
      subject: "Hi\r\nBcc: attacker@evil.com",
      body: "plain body",
    });

    const body = JSON.parse(await capturedRequest!.clone().text()) as {
      Content: { Raw: { Data: string } };
    };
    const raw = Buffer.from(body.Content.Raw.Data, "base64").toString("utf-8");
    // The injected text survives as part of the (harmless) Subject value —
    // that's expected. What must NOT happen is a separate "Bcc:" header
    // line, which is what would actually let an attacker add a recipient.
    const headerLines = raw.split("\r\n\r\n")[0].split("\r\n");
    expect(headerLines.some((line) => line.startsWith("Bcc:"))).toBe(false);
    expect(raw).toContain("Subject: Hi Bcc: attacker@evil.com");
  });

  it("returns a retryable failure on a 5xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("server error", { status: 503 }),
    ) as unknown as typeof fetch;

    const result = await client(fetchImpl).send({
      to: "student@example.com",
      subject: "Hi",
      body: "plain body",
    });

    expect(result).toEqual({
      ok: false,
      error: "ses-503: server error",
      code: "ses-503",
      retryable: true,
    });
  });

  it("returns a non-retryable failure on a 4xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("bad request", { status: 400 }),
    ) as unknown as typeof fetch;

    const result = await client(fetchImpl).send({
      to: "student@example.com",
      subject: "Hi",
      body: "plain body",
    });

    expect(result).toEqual({
      ok: false,
      error: "ses-400: bad request",
      code: "ses-400",
      retryable: false,
    });
  });

  // The two 200-with-a-bad-body branches. SES answering 200 without a MessageId
  // is not a send that half-worked — nothing was accepted, and it must classify
  // distinctly from an unparseable body so a caller reporting `code` says which.
  it("classifies a 200 with no MessageId, and an unparseable 200, distinctly", async () => {
    const noMessageId = vi.fn(async () =>
      jsonResponse(200, { ok: true }),
    ) as unknown as typeof fetch;
    const garbage = vi.fn(
      async () => new Response("<html>nope</html>", { status: 200 }),
    ) as unknown as typeof fetch;

    const missing = await client(noMessageId).send({
      to: "student@example.com",
      subject: "Hi",
      body: "plain body",
    });
    const unparseable = await client(garbage).send({
      to: "student@example.com",
      subject: "Hi",
      body: "plain body",
    });

    expect(missing).toMatchObject({ ok: false, code: "missing-id", retryable: false });
    expect(unparseable).toMatchObject({ ok: false, code: "unparseable", retryable: false });
  });

  it("returns a non-retryable failure on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).send({
      to: "student@example.com",
      subject: "Hi",
      body: "plain body",
    });

    expect(result).toEqual({
      ok: false,
      error: "network: boom",
      code: "network",
      retryable: true,
    });
  });
});
