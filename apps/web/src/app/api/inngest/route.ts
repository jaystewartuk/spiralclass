import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions";
import { serverEnv } from "@/lib/env";

// Inngest serve handler. Inngest Cloud hits this endpoint for function
// invocation; the SDK handles GET (introspection), POST (run), PUT (register).
//
// Local dev:
//   1. Start this Next.js server (`pnpm dev`)
//   2. In another terminal: `npx inngest-cli dev` — it auto-discovers
//      /api/inngest and routes events to it. No creds needed.
// Production: set INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY in Vercel env.
//
// `serveOrigin` pins the URL Inngest stores during PUT registration to
// the canonical domain. Without it the SDK derives the URL from the
// incoming request's host header, which on Vercel is the per-deploy
// preview URL (e.g. `spiralclass-<sha>-…vercel.app`). That URL goes
// 404 on the next deploy, leaving Inngest routing events to a dead
// endpoint — the cause of the silently-stuck `notification.queued`
// rows we saw 2026-05-27. Only applied in production so local dev
// still works via the inngest-cli dev server's auto-discovery.
const env = serverEnv();
const serveOrigin = env.NODE_ENV === "production" ? env.APP_URL.replace(/\/$/, "") : undefined;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
  serveOrigin,
});
