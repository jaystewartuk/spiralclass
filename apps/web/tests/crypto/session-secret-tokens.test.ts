import { describe, expect, it } from "vitest";

import { signOAuthState, verifyOAuthState } from "@/lib/calendar/google/oauth";
import { signEmailOptOutToken, verifyEmailOptOutToken } from "@/lib/email/opt-out-token";
import {
  signNotificationSettingsToken,
  verifyNotificationSettingsToken,
} from "@/lib/notifications/settings-link-token";

// Every token below is base64url(JSON).base64url(HMAC-SHA256) under the same
// key, SESSION_SECRET, and each carries a teacher id and an issue time. Nothing
// in the signature says which purpose a token was minted for, so each
// verifier's `k` check is the only thing between one kind and another. This
// holds every pair to it: a token verifies for its own purpose and no other. A
// new token signed with SESSION_SECRET in this shape belongs in this list.

const SECRET = "test-session-secret-at-least-16-chars";
const TEACHER = "11111111-1111-1111-1111-111111111111";
const STUDENT = "22222222-2222-2222-2222-222222222222";

const KINDS = [
  {
    name: "Google Calendar OAuth state",
    mint: () => signOAuthState(TEACHER, SECRET),
    verifies: (token: string) => verifyOAuthState(token, SECRET).ok,
  },
  {
    name: "email opt-out link",
    mint: () => signEmailOptOutToken({ studentId: STUDENT, teacherId: TEACHER }, SECRET),
    verifies: (token: string) => verifyEmailOptOutToken(token, SECRET).ok,
  },
  {
    name: "notification-settings link",
    mint: () =>
      signNotificationSettingsToken(
        { recipientId: STUDENT, recipientType: "student", teacherId: TEACHER },
        SECRET,
      ),
    verifies: (token: string) => verifyNotificationSettingsToken(token, SECRET).ok,
  },
];

describe("tokens signed with SESSION_SECRET", () => {
  for (const minted of KINDS) {
    for (const verifier of KINDS) {
      const own = minted === verifier;
      it(`${minted.name} token, ${verifier.name} verifier: ${own ? "accepted" : "refused"}`, () => {
        expect(verifier.verifies(minted.mint())).toBe(own);
      });
    }
  }
});
