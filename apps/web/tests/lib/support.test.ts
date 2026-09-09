import { describe, expect, it } from "vitest";
import { SUPPORT_EMAIL } from "@/lib/support";

// SUPPORT_EMAIL is rendered as a `mailto:` link on the legal pages
// (/aviso-de-privacidad, /terminos). Pinning the constant catches a typo
// before it ships, and the test acts as a deliberate breadcrumb for the
// pass that may swap the address out.

describe("SUPPORT_EMAIL", () => {
  it("is a non-empty syntactically-valid email address", () => {
    expect(SUPPORT_EMAIL).toMatch(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/);
  });

  it("points at the spiralclass.com domain (no leaked typos like agendaprof.com)", () => {
    expect(SUPPORT_EMAIL.endsWith("@spiralclass.com")).toBe(true);
  });

  it("matches the provisional mailbox spec'd in the source comment", () => {
    expect(SUPPORT_EMAIL).toBe("support@spiralclass.com");
  });
});
