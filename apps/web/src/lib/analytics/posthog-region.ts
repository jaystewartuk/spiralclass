// Single source of truth for which PostHog Cloud *region* the web app points
// its clients at. See `docs/decisions/D-48.md`: the PostHog project
// is dashboard-pinned to one region and cannot be moved by config — a region
// switch means recreating the project in the other cloud. This knob only aims
// our reverse proxy + browser SDK at the matching regional hosts, so that the
// switch is a config flip (+ project re-create) rather than a code edit.
//
// Default US (launch decision 2026-06-03 — closest to MX users). Set
// NEXT_PUBLIC_POSTHOG_REGION=eu once the EU-Cloud project exists.
export type PosthogRegion = "us" | "eu";

/** Resolve the configured PostHog region; anything but `eu` falls back to US. */
export function posthogRegion(
  raw: string | undefined = process.env.NEXT_PUBLIC_POSTHOG_REGION,
): PosthogRegion {
  return raw?.trim().toLowerCase() === "eu" ? "eu" : "us";
}

/**
 * The regional PostHog hosts for a given region. `ingest`/`assets` are the
 * reverse-proxy destinations (next.config.ts); `ui` is the app host for
 * outbound "view in PostHog" links.
 */
export function posthogRegionHosts(region: PosthogRegion = posthogRegion()) {
  return {
    // Event capture, /flags, /decide.
    ingest: `https://${region}.i.posthog.com`,
    // Recorder + array static bundles the SDK lazy-loads.
    assets: `https://${region}-assets.i.posthog.com`,
    // App UI host (outbound links only, never ingestion).
    ui: `https://${region}.posthog.com`,
  };
}
