import { describe, expect, it } from "vitest";
import { classifyInvitees, isValidEmail, parseInviteeList } from "./bulk";

describe("parseInviteeList", () => {
  it("parses a bare email", () => {
    const { entries } = parseInviteeList("mira@example.com");
    expect(entries).toEqual([
      { name: null, email: "mira@example.com", rawLine: "mira@example.com", lineNumber: 1 },
    ]);
  });

  it("parses name + email in either order", () => {
    expect(parseInviteeList("Mira López, mira@example.com").entries[0]).toMatchObject({
      name: "Mira López",
      email: "mira@example.com",
    });
    expect(parseInviteeList("mira@example.com, Mira López").entries[0]).toMatchObject({
      name: "Mira López",
      email: "mira@example.com",
    });
  });

  it("parses the Name <email> form", () => {
    expect(parseInviteeList("Mira López <mira@example.com>").entries[0]).toMatchObject({
      name: "Mira López",
      email: "mira@example.com",
    });
  });

  it("normalizes email case + whitespace", () => {
    expect(parseInviteeList("  Mira , MIRA@Example.COM ").entries[0]).toMatchObject({
      name: "Mira",
      email: "mira@example.com",
    });
  });

  it("handles CSV with a header row and tabs/semicolons", () => {
    const input = "name,email\nAna;mira@example.com\nJuan\tjuan@example.com";
    const { entries } = parseInviteeList(input);
    expect(entries.map((e) => e.email)).toEqual(["mira@example.com", "juan@example.com"]);
  });

  it("flags rows without a valid email as issues", () => {
    const { entries, issues } = parseInviteeList("not-an-email\nAna, nope@\n");
    expect(entries).toHaveLength(0);
    expect(issues).toHaveLength(2);
    expect(issues[0].reason).toBe("missing_email");
    expect(issues[1].reason).toBe("invalid_email");
  });

  it("skips blank lines", () => {
    const { entries } = parseInviteeList("\n\nana@example.com\n\n");
    expect(entries).toHaveLength(1);
  });
});

describe("isValidEmail", () => {
  it("accepts normal emails and rejects junk", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
    expect(isValidEmail("@c.com")).toBe(false);
  });
});

describe("classifyInvitees", () => {
  const entries = [
    { name: null, email: "a@x.com", rawLine: "", lineNumber: 1 },
    { name: null, email: "a@x.com", rawLine: "", lineNumber: 2 }, // dup
    { name: null, email: "connected@x.com", rawLine: "", lineNumber: 3 },
    { name: null, email: "pending@x.com", rawLine: "", lineNumber: 4 },
    { name: null, email: "fresh@x.com", rawLine: "", lineNumber: 5 },
  ];

  it("categorizes duplicates, connected, pending, and sendable", () => {
    const result = classifyInvitees({
      entries,
      connectedEmails: new Set(["connected@x.com"]),
      pendingEmails: new Set(["pending@x.com"]),
    });
    const byEmail = Object.fromEntries(
      result.classified.map((c) => [`${c.email}:${c.lineNumber}`, c.disposition]),
    );
    expect(byEmail["a@x.com:1"]).toBe("ok");
    expect(byEmail["a@x.com:2"]).toBe("duplicate_in_list");
    expect(byEmail["connected@x.com:3"]).toBe("already_connected");
    expect(byEmail["pending@x.com:4"]).toBe("already_invited");
    expect(byEmail["fresh@x.com:5"]).toBe("ok");
    expect(result.sendable.map((s) => s.email)).toEqual(["a@x.com", "fresh@x.com"]);
    expect(result.counts.ok).toBe(2);
    expect(result.counts.duplicate_in_list).toBe(1);
  });
});
