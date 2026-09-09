import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";

// Shared-secret auth for the /api/internal/captions/* routes, called by the
// self-hosted LiveKit captions Agent (packages/livekit-captions-agent) —
// a trusted server-to-server caller with no browser session, so it can't use
// the cookie/CSRF checks the human-viewer caption routes rely on. The route is
// dark (404-not-401) whenever the secret env var isn't set, so a misconfigured
// deploy fails closed rather than open. Unlike the Maestro preview seam this
// was modeled on (deleted with the app), it is NOT
// preview-only — the Agent must reach these routes in production too.
//
// The comparison is constant-time. `===` on two strings returns as soon as a
// byte differs, so how long the check takes is a function of how much of the
// secret the caller got right. Over the public internet that signal is buried
// in jitter and no practical attack is known against it here — but this file
// is public now, the endpoint is reachable from anywhere, and the fix is four
// lines. SHA-256 first so both sides are 32 bytes: `timingSafeEqual` throws on
// a length mismatch, and letting a length difference throw would reintroduce
// the leak it exists to remove.
export function captionsAgentAuthOk(req: Request): boolean {
  const expected = serverEnv().CAPTIONS_AGENT_SHARED_SECRET;
  if (!expected) return false;
  const presented = req.headers.get("x-captions-agent-secret");
  if (!presented) return false;
  return timingSafeEqual(sha256(presented), sha256(expected));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
