import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { Badge, Spinner, StatusMessage } from "@inkjs/ui";
// Through livekit-server-sdk, which re-exports these, rather than from
// `@livekit/protocol` directly — that is a phantom dependency this package
// never declared, so it resolved to whatever version the root hoisted (1.50.4)
// while the SDK's own methods return its nested 1.48.0 types. Two structurally
// different `Room`s, and `tsc` rightly refused to assign one to the other.
import { RoomServiceClient, type ParticipantInfo, type Room } from "livekit-server-sdk";

// Prototype: an Ink live dashboard for the self-hosted LiveKit box's room
// activity (see docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md). Talks to
// livekit-server-sdk's RoomServiceClient directly — no `lk` CLI, no `watch`
// shell-out — so every render is a real React state update, not a redrawn
// terminal frame from an external process.

export type AppProps = {
  url: string;
  apiKey: string;
  apiSecret: string;
  intervalMs: number;
};

type RoomActivity = {
  room: Room;
  participants: ParticipantInfo[];
};

function formatDuration(sinceMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// A room's `name` is the booking id (see lib/video/provider.ts's
// classCallRoom) — shorten it so the table doesn't blow out to full-width
// UUIDs when there's only ever 1-2 rooms live at once (1:1 lessons, D-88).
function shortRoomLabel(name: string): string {
  const bookingId = name.replace(/^class-/, "");
  return bookingId.length > 12 ? `${bookingId.slice(0, 8)}…` : bookingId;
}

export function App({ url, apiKey, apiSecret, intervalMs }: AppProps) {
  const { exit } = useApp();
  const client = useMemo(
    () => new RoomServiceClient(url, apiKey, apiSecret),
    [url, apiKey, apiSecret],
  );

  const [activity, setActivity] = useState<RoomActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const rooms = await client.listRooms();
        const withParticipants = await Promise.all(
          rooms.map(async (room) => ({
            room,
            participants: await client.listParticipants(room.name),
          })),
        );
        if (cancelled) return;
        setActivity(withParticipants);
        setError(null);
        setLastUpdated(new Date());
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // Deliberately re-runs only when the poll cadence changes — `client` is
    // memoized on the same three args this effect doesn't otherwise depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, intervalMs]);

  // A second, faster tick just to keep the "Xs ago" / duration counters
  // live between polls — LiveKit itself is only asked every `intervalMs`.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  void tick; // referenced only to force a re-render each second

  useEffect(() => {
    process.on("SIGINT", () => exit());
  }, [exit]);

  const totalParticipants = activity?.reduce((sum, a) => sum + a.room.numParticipants, 0) ?? 0;

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text bold color="cyan">
          ◉ LiveKit Activity
        </Text>
        {activity === null && error === null ? <Spinner label="Connecting…" /> : null}
        <Badge color={totalParticipants > 0 ? "green" : "gray"}>
          {totalParticipants} participant{totalParticipants === 1 ? "" : "s"}
        </Badge>
        <Text dimColor>{url}</Text>
      </Box>

      {error && (
        <StatusMessage variant="error">
          {error} — retrying every {Math.round(intervalMs / 1000)}s
        </StatusMessage>
      )}

      {activity && activity.length === 0 && !error && (
        <Text dimColor>No active rooms right now.</Text>
      )}

      {activity && activity.length > 0 && (
        <Box flexDirection="column">
          {activity.map(({ room, participants }) => (
            <Box
              key={room.sid}
              flexDirection="column"
              borderStyle="round"
              borderColor="green"
              paddingX={1}
              marginBottom={1}
            >
              <Box gap={1}>
                <Text bold>{shortRoomLabel(room.name)}</Text>
                <Text dimColor>{room.sid}</Text>
                <Badge color="blue">{formatDuration(Number(room.creationTimeMs))} old</Badge>
              </Box>
              {participants.map((p) => (
                <Box key={p.identity} gap={1} paddingLeft={2}>
                  <Text color={p.tracks.length > 0 ? "green" : "yellow"}>
                    {p.tracks.length > 0 ? "●" : "○"}
                  </Text>
                  <Text>{p.identity}</Text>
                  <Text dimColor>
                    {p.tracks.length} track{p.tracks.length === 1 ? "" : "s"}
                  </Text>
                  <Text dimColor>joined {formatDuration(Number(p.joinedAt) * 1000)} ago</Text>
                </Box>
              ))}
              {participants.length === 0 && (
                <Box paddingLeft={2}>
                  <Text dimColor>(no participants — room open, empty)</Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}

      <Text dimColor>
        {lastUpdated ? `updated ${lastUpdated.toLocaleTimeString()}` : "waiting for first fetch…"} ·
        refresh every {Math.round(intervalMs / 1000)}s · Ctrl+C to exit
      </Text>
    </Box>
  );
}
