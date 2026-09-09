import { defineConfig } from "vitest/config";

// The shared wire-types package owns the unit tests for the pure utilities it
// exports (e.g. email-suggest). Type-only modules carry no runtime logic, so
// the suite is small and runs under plain Node.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
