// The Sentry `environment` tag for this deployment. NOT `process.env.NODE_ENV`:
// Next.js production *builds* always set NODE_ENV=production, so a preview
// deploy and a production deploy would both report "production" and their
// errors would mix. Derive it from the actual deployment instead.
//
// Used by all three Sentry inits (server, edge, client) so a given deployment
// reports one consistent environment across runtimes.
export function sentryEnvironment(): "production" | "preview" | "development" {
  // Client bundle: server env vars aren't available, but the hostname is
  // authoritative and needs no NEXT_PUBLIC_* var baked at build time.
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return "development";
    return host.includes("preview") ? "preview" : "production";
  }
  // Server / edge: derive from APP_URL, a first-class app var always present at
  // runtime — same reasoning as isProductionDeployment() in lib/env.ts. (Pre-D-89
  // this preferred Vercel's VERCEL_ENV; Vercel is gone, so APP_URL is the source.)
  const url = process.env.APP_URL ?? "";
  if (url.includes("localhost")) return "development";
  return url.includes("preview") ? "preview" : "production";
}
