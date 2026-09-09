import { describe, expect, it } from "vitest";
import { invariant, InvariantViolation } from "@/lib/invariant";

describe("invariant", () => {
  it("returns silently when condition is truthy", () => {
    expect(() => invariant(true, "test.ok", "should not throw")).not.toThrow();
    expect(() => invariant(1, "test.ok", "truthy non-bool")).not.toThrow();
  });

  it("throws InvariantViolation with name, message, and context when condition is falsy", () => {
    try {
      invariant(false, "test.bad", "expected violation", { foo: "bar" });
      throw new Error("invariant did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvariantViolation);
      const v = err as InvariantViolation;
      expect(v.name).toBe("InvariantViolation");
      expect(v.invariant).toBe("test.bad");
      expect(v.message).toContain("[invariant: test.bad]");
      expect(v.message).toContain("expected violation");
      expect(v.context).toEqual({ foo: "bar" });
    }
  });
});
