import { describe, expect, it } from "vitest";
import { buildWhatsAppUrl } from "./support";

describe("buildWhatsAppUrl", () => {
  it("returns null for an empty number", () => {
    expect(buildWhatsAppUrl("")).toBeNull();
  });

  it("returns null for a whitespace-only number", () => {
    expect(buildWhatsAppUrl("   ")).toBeNull();
  });

  it("strips non-digit characters from the number", () => {
    const url = buildWhatsAppUrl("+52 55 1234-5678");
    expect(url).toContain("wa.me/525512345678");
  });

  it("produces a wa.me URL with a text query param", () => {
    const url = buildWhatsAppUrl("5215512345678");
    expect(url).toMatch(/^https:\/\/wa\.me\/5215512345678\?text=/);
  });

  it("always includes the greeting line", () => {
    const url = buildWhatsAppUrl("5215512345678");
    const text = decodeURIComponent(url!.split("text=")[1]);
    expect(text).toContain("Hola, necesito ayuda con SpiralClass.");
  });

  it("includes the page URL when provided", () => {
    const url = buildWhatsAppUrl("5215512345678", {
      page: "https://spiralclass.com/dashboard",
    });
    const text = decodeURIComponent(url!.split("text=")[1]);
    expect(text).toContain("Página: https://spiralclass.com/dashboard");
  });

  it("includes the user ID when provided", () => {
    const url = buildWhatsAppUrl("5215512345678", { userId: "teacher_abc123" });
    const text = decodeURIComponent(url!.split("text=")[1]);
    expect(text).toContain("Usuario: teacher_abc123");
  });

  it("includes the replay URL when provided", () => {
    const url = buildWhatsAppUrl("5215512345678", {
      replayUrl: "https://us.posthog.com/project/example/replay/xyz",
    });
    const text = decodeURIComponent(url!.split("text=")[1]);
    expect(text).toContain("Sesión: https://us.posthog.com/project/example/replay/xyz");
  });

  it("omits optional fields when not provided", () => {
    const url = buildWhatsAppUrl("5215512345678");
    const text = decodeURIComponent(url!.split("text=")[1]);
    expect(text).not.toContain("Página:");
    expect(text).not.toContain("Usuario:");
    expect(text).not.toContain("Sesión:");
  });

  it("ignores null userId", () => {
    const url = buildWhatsAppUrl("5215512345678", { userId: null });
    const text = decodeURIComponent(url!.split("text=")[1]);
    expect(text).not.toContain("Usuario:");
  });

  it("ignores null replayUrl", () => {
    const url = buildWhatsAppUrl("5215512345678", { replayUrl: null });
    const text = decodeURIComponent(url!.split("text=")[1]);
    expect(text).not.toContain("Sesión:");
  });
});
