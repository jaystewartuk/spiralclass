#!/usr/bin/env node
import { render } from "ink";
import { App } from "./App.js";

// Entry point. Expects LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET already
// in the environment — this deliberately does NOT talk to Infisical itself
// (keeps this package a pure UI prototype); the wrapper script
// infra/infisical/livekit-activity-ink.sh pulls the secret and execs this.
//
// Usage: LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
//   pnpm --filter @spiralclass/livekit-activity-cli start [-- --interval-ms 2000]

function readArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const intervalMs = Number(readArg("--interval-ms") ?? 2000);

if (!url || !apiKey || !apiSecret) {
  console.error(
    "Missing LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET in the environment.\n" +
      "Run via infra/infisical/livekit-activity-ink.sh (pulls the secret from Infisical), not this script directly.",
  );
  process.exit(1);
}

render(<App url={url} apiKey={apiKey} apiSecret={apiSecret} intervalMs={intervalMs} />);
