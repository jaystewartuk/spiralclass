import { describe, expect, it } from "vitest";
import { canAdminRetryNotification, isDispatcherReplayable } from "./admin-retry";

describe("canAdminRetryNotification", () => {
  it("offers Retry on a failed or queued dispatcher notification", () => {
    expect(
      canAdminRetryNotification({ status: "failed", templateName: "booking_confirmation" }),
    ).toBe(true);
    expect(
      canAdminRetryNotification({ status: "queued", templateName: "booking_confirmation" }),
    ).toBe(true);
  });

  it("never offers Retry on a sent or delivered row", () => {
    expect(
      canAdminRetryNotification({ status: "sent", templateName: "booking_confirmation" }),
    ).toBe(false);
    expect(
      canAdminRetryNotification({ status: "delivered", templateName: "booking_confirmation" }),
    ).toBe(false);
  });

  it("never offers Retry on a bounced invitation (issue #85)", () => {
    expect(canAdminRetryNotification({ status: "failed", templateName: "invitation" })).toBe(false);
    expect(isDispatcherReplayable("invitation")).toBe(false);
  });
});
