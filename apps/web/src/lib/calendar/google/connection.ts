import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { encryptField, decryptField } from "@/lib/crypto/field-encryption";
import { GOOGLE_REFRESH_TOKEN_COLUMN } from "./config";
import { revokeToken } from "./oauth";

// Connection lifecycle for Google busy-import: persist tokens on the OAuth
// callback and tear everything down on disconnect. The refresh token is
// field-encrypted at rest (plaintext fallback when no master key), mirroring
// the Wise credential write path.

type Db = PrismaClient;

function sealRefreshToken(token: string): string {
  return encryptField(GOOGLE_REFRESH_TOKEN_COLUMN, token) ?? token;
}

export async function saveGoogleConnection(
  input: {
    teacherId: string;
    refreshToken: string | null;
    accessToken: string;
    expiresInSeconds: number;
    googleEmail: string | null;
  },
  db: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<void> {
  const accessTokenExpiresAt = new Date(now.getTime() + input.expiresInSeconds * 1000);

  // Google only returns a refresh token on first consent; we force prompt=consent
  // so it should always be present, but if a re-consent omits it, keep the
  // existing one rather than clobbering the connection.
  const existing = await db.googleCalendarConnection.findUnique({
    where: { teacherId: input.teacherId },
    select: { refreshTokenEnc: true },
  });
  const refreshTokenEnc = input.refreshToken
    ? sealRefreshToken(input.refreshToken)
    : existing?.refreshTokenEnc;
  if (!refreshTokenEnc) {
    throw new Error("google connection: no refresh token available");
  }

  await db.googleCalendarConnection.upsert({
    where: { teacherId: input.teacherId },
    create: {
      teacherId: input.teacherId,
      googleEmail: input.googleEmail,
      refreshTokenEnc,
      accessToken: input.accessToken,
      accessTokenExpiresAt,
      syncEnabled: true,
    },
    update: {
      googleEmail: input.googleEmail ?? undefined,
      refreshTokenEnc,
      accessToken: input.accessToken,
      accessTokenExpiresAt,
      syncEnabled: true,
      lastSyncError: null,
    },
  });
}

/** Remove the connection + all imported busy intervals, and revoke the token. */
export async function disconnectGoogleCalendar(
  teacherId: string,
  db: Db = defaultPrisma,
): Promise<void> {
  const connection = await db.googleCalendarConnection.findUnique({
    where: { teacherId },
    select: { refreshTokenEnc: true },
  });
  if (connection) {
    const token =
      decryptField(GOOGLE_REFRESH_TOKEN_COLUMN, connection.refreshTokenEnc) ??
      connection.refreshTokenEnc;
    await revokeToken(token);
  }
  await db.$transaction([
    db.googleBusyInterval.deleteMany({ where: { teacherId } }),
    db.googleCalendarConnection.deleteMany({ where: { teacherId } }),
  ]);
}
