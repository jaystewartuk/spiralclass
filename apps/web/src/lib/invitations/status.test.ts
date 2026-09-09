import { describe, expect, it } from "vitest";
import { effectiveInvitationStatus, isAcceptable, isTerminalStatus } from "./status";

const now = new Date("2026-07-18T12:00:00Z");
const future = new Date("2026-08-18T12:00:00Z");
const past = new Date("2026-07-10T12:00:00Z");

describe("effectiveInvitationStatus", () => {
  it("returns pending for an unexpired pending row", () => {
    expect(effectiveInvitationStatus({ status: "pending", expiresAt: future }, now)).toBe(
      "pending",
    );
  });

  it("derives expired from a pending row past its window", () => {
    expect(effectiveInvitationStatus({ status: "pending", expiresAt: past }, now)).toBe("expired");
  });

  it("treats the exact expiry instant as expired", () => {
    expect(effectiveInvitationStatus({ status: "pending", expiresAt: now }, now)).toBe("expired");
  });

  it("passes terminal states through unchanged", () => {
    expect(effectiveInvitationStatus({ status: "accepted", expiresAt: past }, now)).toBe(
      "accepted",
    );
    expect(effectiveInvitationStatus({ status: "cancelled", expiresAt: future }, now)).toBe(
      "cancelled",
    );
  });
});

describe("isAcceptable", () => {
  it("is true only for an unexpired pending row", () => {
    expect(isAcceptable({ status: "pending", expiresAt: future }, now)).toBe(true);
    expect(isAcceptable({ status: "pending", expiresAt: past }, now)).toBe(false);
    expect(isAcceptable({ status: "accepted", expiresAt: future }, now)).toBe(false);
    expect(isAcceptable({ status: "cancelled", expiresAt: future }, now)).toBe(false);
  });
});

describe("isTerminalStatus", () => {
  it("marks accepted and cancelled as terminal", () => {
    expect(isTerminalStatus("accepted")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("expired")).toBe(false);
  });
});
