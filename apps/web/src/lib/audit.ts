import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BOOTSTRAP_ACTOR_ID, type AdminActor } from "@/lib/admin";
import { logger } from "@/lib/logger";
import type { OverrideTargetType } from "@prisma/client";

const log = logger({ surface: "audit" });

export type WriteOverrideInput = {
  // The affected teacher's id. Pass `null` for a platform-scoped action with
  // no single teacher (e.g. an action on a standalone student with no teacher
  // link) — the row is still recorded so nothing goes unaudited. `teacher_id`
  // is nullable in the schema for exactly this case.
  teacherId: string | null;
  targetType: OverrideTargetType;
  targetId: string;
  // Short verb such as "refund", "cancel_package", "extend_expiration",
  // "disable_teacher". Free-form for now; filters in the audit page do
  // case-insensitive substring match.
  action: string;
  reason: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  // The platform admin who acted. Pass `null` for teacher-initiated
  // overrides. When the actor is a bootstrap superadmin (no DB row yet)
  // we drop the FK to NULL — the action still logs, just unattributed.
  actor: AdminActor | null;
  // Pass an active transaction client to fold the override write into
  // an existing $transaction. Defaults to the top-level prisma client.
  tx?: Prisma.TransactionClient;
};

// Records a single audit row in `overrides`. Designed to be called from
// inside an existing $transaction so the audit is atomic with the
// underlying mutation. Returns the created row's id.
export async function writeOverride(input: WriteOverrideInput): Promise<string> {
  const client = input.tx ?? prisma;
  const actorAdminId = input.actor && input.actor.id !== BOOTSTRAP_ACTOR_ID ? input.actor.id : null;

  const row = await client.override.create({
    data: {
      teacherId: input.teacherId,
      targetType: input.targetType,
      targetId: input.targetId,
      action: input.action,
      reason: input.reason,
      beforeJson: input.before ?? Prisma.JsonNull,
      afterJson: input.after ?? Prisma.JsonNull,
      actorAdminId,
    },
    select: { id: true },
  });

  // Out-of-band copy of the audit event. The `overrides` table is append-only
  // at the DB level (migration 20260625000000), but a logger sink lives
  // outside the DB entirely, so the trail survives even a DB-credential
  // holder. Cheap; admin write volume is low.
  log.info("override", {
    overrideId: row.id,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    teacherId: input.teacherId,
    actorAdminId,
  });

  return row.id;
}
