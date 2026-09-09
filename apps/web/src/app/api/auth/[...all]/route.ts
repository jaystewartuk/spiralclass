import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/server";

// better-auth catch-all handler (D-40) — replaces /api/auth/callback and the
// bespoke mobile auth routes. Mounts every better-auth endpoint
// (/api/auth/sign-in/email-otp, /api/auth/get-session, /api/auth/two-factor/*, …).
export const { GET, POST } = toNextJsHandler(auth);
