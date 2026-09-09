import { defineConfig } from "vitest/config";

// Unit tests for the pure/testable bits of the captions Agent (protocol
// direction resolution, backoff math, Deepgram message parsing, env
// validation) — the LiveKit room/track/WebSocket glue itself needs a real
// self-hosted box to exercise, same as this repo's other LiveKit-adjacent
// code.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
