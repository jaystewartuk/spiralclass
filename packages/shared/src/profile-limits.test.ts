import { describe, expect, it } from "vitest";
import { BIO_MAX_LENGTH, HEADLINE_MAX_LENGTH } from "./profile-limits";

describe("profile-limits", () => {
  it("caps the headline at 80 characters", () => {
    expect(HEADLINE_MAX_LENGTH).toBe(80);
  });

  it("caps the bio at 280 characters", () => {
    expect(BIO_MAX_LENGTH).toBe(280);
  });
});
