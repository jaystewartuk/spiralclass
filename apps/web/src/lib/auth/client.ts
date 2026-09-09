"use client";

import { createAuthClient } from "better-auth/react";
import { emailOTPClient, twoFactorClient } from "better-auth/client/plugins";

// better-auth browser client (D-40). Mirrors the server instance's plugins.
// baseURL is inferred from window.location, so one build works across
// preview/production hosts. Used by the sign-in / sign-up forms and the admin
// TOTP enrolment UI.
export const authClient = createAuthClient({
  plugins: [emailOTPClient(), twoFactorClient()],
});
