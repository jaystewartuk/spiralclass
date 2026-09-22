import { describe, expect, it } from "vitest";

import { webPathForDeepLink } from "@/lib/notifications/web-deep-links";

// The dispatcher emits ONE path suffix per notification, shared by the email
// CTA, the push payload, and the in-app inbox. Chat/class/book suffixes are
// role-prefixed for the mobile router (`t/` teacher, `s/` student) and have no
// matching web route — these assert the web translation, and that every
// already-web suffix still passes straight through.

describe("webPathForDeepLink — chat threads", () => {
  it("maps a teacher chat suffix to the teacher conversation page", () => {
    expect(webPathForDeepLink("t/messages/student-abc")).toBe("/dashboard/messages/student-abc");
  });

  it("maps a student chat suffix to the student conversation page", () => {
    expect(webPathForDeepLink("s/messages/teacher-xyz")).toBe("/my-classes/messages/teacher-xyz");
  });

  it("falls back to the thread list when the id segment is missing", () => {
    expect(webPathForDeepLink("t/messages")).toBe("/dashboard/messages");
    expect(webPathForDeepLink("t/messages/")).toBe("/dashboard/messages");
    expect(webPathForDeepLink("s/messages")).toBe("/my-classes/messages");
    expect(webPathForDeepLink("s/messages/")).toBe("/my-classes/messages");
  });
});

describe("webPathForDeepLink — other role-prefixed suffixes", () => {
  it("maps the student class-detail suffix", () => {
    expect(webPathForDeepLink("s/class/booking-1")).toBe("/my-classes/booking-1");
  });

  it("maps the student book suffix", () => {
    expect(webPathForDeepLink("s/book")).toBe("/my-classes/book");
  });

  it("only matches a role prefix on a path-segment boundary", () => {
    // `s/classroom` must not be read as `s/class` + "room".
    expect(webPathForDeepLink("s/classroom")).toBe("/s/classroom");
  });
});

describe("webPathForDeepLink — pass-through", () => {
  it("leaves suffixes that are already web paths untouched", () => {
    expect(webPathForDeepLink("dashboard/classes/b1")).toBe("/dashboard/classes/b1");
    expect(webPathForDeepLink("payments/p1")).toBe("/payments/p1");
    expect(webPathForDeepLink("settings/billing")).toBe("/settings/billing");
    expect(webPathForDeepLink("my-classes/materials")).toBe("/my-classes/materials");
    expect(webPathForDeepLink("b/alicia-moreno")).toBe("/b/alicia-moreno");
  });

  it("normalises a leading slash", () => {
    expect(webPathForDeepLink("/payments/p1")).toBe("/payments/p1");
  });

  it("passes absolute URLs through", () => {
    expect(webPathForDeepLink("https://example.com/x")).toBe("https://example.com/x");
  });

  it("returns null for empty / missing suffixes", () => {
    expect(webPathForDeepLink(null)).toBeNull();
    expect(webPathForDeepLink(undefined)).toBeNull();
    expect(webPathForDeepLink("")).toBeNull();
    expect(webPathForDeepLink("/")).toBeNull();
  });

  it("never produces a protocol-relative URL that escapes the origin", () => {
    expect(webPathForDeepLink("//evil.example")).toBe("/evil.example");
  });
});
