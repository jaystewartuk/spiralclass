import type { GoogleCalendarConnection, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { decryptField } from "@/lib/crypto/field-encryption";
import { GOOGLE_REFRESH_TOKEN_COLUMN } from "./config";
import { refreshAccessToken } from "./oauth";
import { queryFreeBusy } from "./freebusy";

// Per-teacher + batch busy-import sync. Refreshes a Google access token when
// the cached one is stale, queries free/busy across the booking window, and
// replaces the teacher's stored busy intervals wholesale. No-ops cleanly when
// nothing is connected.

const ACCESS_TOKEN_SKEW_MS = 60_000; // refresh a minute early to avoid races
const MAX_WINDOW_DAYS = 60; // cap the free/busy lookahead
const SYNC_CONCURRENCY = 5; // teachers synced in parallel per batch in the cron

type Db = PrismaClient;

/** Decrypt the stored refresh token (plaintext fallback when no master key). */
function openRefreshToken(enc: string): string {
  return decryptField(GOOGLE_REFRESH_TOKEN_COLUMN, enc) ?? enc;
}

/**
 * Return a usable access token, refreshing + persisting a new one when the
 * cached token is missing or about to expire.
 */
export async function getValidAccessToken(
  connection: GoogleCalendarConnection,
  db: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<string> {
  const stillValid =
    connection.accessToken &&
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt.getTime() - ACCESS_TOKEN_SKEW_MS > now.getTime();
  if (stillValid && connection.accessToken) return connection.accessToken;

  const refreshed = await refreshAccessToken(openRefreshToken(connection.refreshTokenEnc));
  const expiresAt = new Date(now.getTime() + refreshed.expiresInSeconds * 1000);
  await db.googleCalendarConnection.update({
    where: { teacherId: connection.teacherId },
    data: { accessToken: refreshed.accessToken, accessTokenExpiresAt: expiresAt },
  });
  return refreshed.accessToken;
}

export type SyncResult =
  | { teacherId: string; status: "skipped"; reason: string }
  | { teacherId: string; status: "synced"; intervals: number }
  | { teacherId: string; status: "error"; error: string };

/** Sync one teacher's busy intervals. Records failures on the row, never throws. */
export async function syncTeacherBusy(
  teacherId: string,
  db: Db = defaultPrisma,
): Promise<SyncResult> {
  // Fetch the connection and the teacher's maxAdvanceDays in a single round
  // trip via the relation, rather than a second findUnique on `teacher`.
  const connection = await db.googleCalendarConnection.findUnique({
    where: { teacherId },
    include: { teacher: { select: { maxAdvanceDays: true } } },
  });
  if (!connection) return { teacherId, status: "skipped", reason: "not-connected" };
  if (!connection.syncEnabled) return { teacherId, status: "skipped", reason: "sync-disabled" };

  const windowDays = Math.min(
    connection.teacher?.maxAdvanceDays ?? MAX_WINDOW_DAYS,
    MAX_WINDOW_DAYS,
  );

  try {
    const accessToken = await getValidAccessToken(connection, db);
    const now = new Date();
    const timeMax = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const busy = await queryFreeBusy(accessToken, { timeMin: now, timeMax });

    await db.$transaction([
      db.googleBusyInterval.deleteMany({ where: { teacherId } }),
      ...(busy.length
        ? [
            db.googleBusyInterval.createMany({
              data: busy.map((b) => ({ teacherId, startsAt: b.startsAt, endsAt: b.endsAt })),
            }),
          ]
        : []),
      db.googleCalendarConnection.update({
        where: { teacherId },
        data: { lastSyncedAt: new Date(), lastSyncError: null },
      }),
    ]);

    return { teacherId, status: "synced", intervals: busy.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.googleCalendarConnection
      .update({ where: { teacherId }, data: { lastSyncError: message.slice(0, 500) } })
      .catch(() => {});
    return { teacherId, status: "error", error: message };
  }
}

/** Sync every connected, sync-enabled teacher. Used by the polling cron. */
export async function syncAllConnectedTeachers(db: Db = defaultPrisma): Promise<{
  total: number;
  synced: number;
  errors: number;
  skipped: number;
}> {
  const connections = await db.googleCalendarConnection.findMany({
    where: { syncEnabled: true },
    select: { teacherId: true },
  });
  let synced = 0;
  let errors = 0;
  let skipped = 0;
  // Sync teachers concurrently in bounded batches. A serial loop made the
  // cron's wall-clock scale linearly with the connected-teacher count; a small
  // concurrency window keeps it fast without hammering Google's free/busy API
  // (each syncTeacherBusy is self-contained and never throws).
  for (let i = 0; i < connections.length; i += SYNC_CONCURRENCY) {
    const batch = connections.slice(i, i + SYNC_CONCURRENCY);
    const results = await Promise.all(batch.map(({ teacherId }) => syncTeacherBusy(teacherId, db)));
    for (const result of results) {
      if (result.status === "synced") synced++;
      else if (result.status === "error") errors++;
      else skipped++;
    }
  }
  return { total: connections.length, synced, errors, skipped };
}
