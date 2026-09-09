import { setDefaultResultOrder } from "node:dns";
import { loadConfig } from "./config";
import { Discovery } from "./discovery";
import { logEvent } from "./log";

// The Oracle box has a global IPv6 address but NO IPv6 default route, so any
// v6 connect fails with ENETUNREACH. The app host (spiralclass.com) is behind
// Cloudflare and publishes AAAA records alongside A, and Node 18+ defaults to
// `verbatim` ordering — so it will periodically try the v6 address first and
// fail on a network that has no way to reach it. Pinning ipv4first removes the
// trigger outright rather than relying on every call site to survive it.
// (app-client.ts still fails soft, because a real outage looks the same.)
//
// Deliberately here and not in the Dockerfile/compose as NODE_OPTIONS: this is
// a property of the box's network, and the box's compose is hand-maintained
// and drifts (see D-108), so an env var is the more likely thing to get lost.
setDefaultResultOrder("ipv4first");

const config = loadConfig();
const discovery = new Discovery(config);

logEvent("agent_starting", { livekitUrl: config.livekitUrl });
discovery.start();

async function shutdown(signal: string): Promise<void> {
  logEvent("agent_stopping", { signal });
  await discovery.stop();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
