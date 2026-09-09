// Thin client for the Next.js app's /api/internal/captions/room-config route.
// Consent/language/entitlement business logic stays server-side in the app,
// reusing its existing tested functions — this Agent never talks to the
// database directly and never re-implements any of that logic. Translation
// (previously a second app route) is now a direct Agent -> Anthropic call
// (see translate.ts) — that hop had no DB/business-logic dependency of its
// own, unlike room-config, so routing it through the app was pure added
// latency for nothing.

import { logEvent } from "./log";

export type CaptionDirection = { source: string; target: string };

export type RoomConfig =
  | { enabled: false }
  | {
      enabled: true;
      bookingId: string;
      teacherId: string;
      studentId: string;
      teacherDirection: CaptionDirection;
      studentDirection: CaptionDirection;
      studentCaptionsAllowed: boolean;
    };

export class AppClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
  ) {}

  // Returns null on ANY failure, including a network-level one. A rejected
  // fetch here is not exceptional — it is a long-lived process on a box with
  // no IPv6 route calling a Cloudflare-fronted host that publishes AAAA
  // records, so `ENETUNREACH` is a routine outcome whenever Node's default
  // `verbatim` DNS ordering hands back the v6 address first (index.ts pins
  // ipv4first to make that rare, but "rare" is not "never" — a genuine
  // outage, DNS blip or TLS reset lands here the same way).
  //
  // Before this, the bare `await fetch` rejected into callers that invoke it
  // as `void this.tick()` / `void this.refreshRoomConfig()` — fire-and-forget,
  // so nothing could catch it, so Node 22 killed the process. Production
  // 2026-07-29: the Agent died twice within a minute mid-class on exactly
  // this path. `restart: unless-stopped` masked it as a ~1s captions dropout
  // rather than an outage, which is why it went unnoticed.
  //
  // Every caller already handles null (roomConfig's own `!data?.ok` check,
  // and refreshRoomConfig keeps the last known config on a null), so failing
  // soft here degrades to "keep captioning with what we last knew" instead of
  // taking the whole Agent down for every room.
  private async post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-captions-agent-secret": this.sharedSecret,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        logEvent("app_request_failed", { path, status: res.status });
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      logEvent("app_request_error", { path, error: String(err) });
      return null;
    }
  }

  async roomConfig(room: string): Promise<RoomConfig | null> {
    const data = await this.post<{ ok: boolean } & RoomConfig>(
      "/api/internal/captions/room-config",
      {
        room,
      },
    );
    if (!data?.ok) return null;
    return data;
  }
}
