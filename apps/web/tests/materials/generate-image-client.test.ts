import { afterEach, describe, expect, it, vi } from "vitest";
import { generateMaterialImageFromDescription } from "@/lib/materials/upload-image";

// The editor's half of "Generate image": one POST, and the same `{ src }` or
// `{ error }` an upload returns, so the editor inserts both the same way.

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

const reply = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

describe("generateMaterialImageFromDescription", () => {
  it("posts the description and returns the src", async () => {
    reply(200, { ok: true, src: "material-image:k.png" });
    expect(await generateMaterialImageFromDescription("Un mercado", "fallback")).toEqual({
      src: "material-image:k.png",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/materials/images/generate");
    expect(JSON.parse(init.body)).toEqual({ description: "Un mercado" });
  });

  it("prefers the server's own message, which is already in her language", async () => {
    reply(422, { ok: false, message: "Prueba a describirla de otra manera." });
    expect(await generateMaterialImageFromDescription("x y z", "fallback")).toEqual({
      error: "Prueba a describirla de otra manera.",
    });
  });

  it("falls back when there is no usable answer at all", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await generateMaterialImageFromDescription("x y z", "fallback")).toEqual({
      error: "fallback",
    });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 502 }));
    expect(await generateMaterialImageFromDescription("x y z", "fallback")).toEqual({
      error: "fallback",
    });
  });
});
