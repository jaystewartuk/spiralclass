import { Prisma, type PrismaClient } from "@prisma/client";
import { type PayoutInstrumentKind, isInstrumentReady } from "@spiralclass/shared";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { maybeEmitMarketplaceReady } from "@/lib/marketplace-ready";

// The single write path for a teacher's payout instrument.
//
// It exists as one function because of the two side effects, not the upsert:
// the `payout_rail_connected` off→on gate and the marketplace-ready recheck
// both have to happen on exactly the same transition, and any caller that
// re-implemented them would drift the activation funnel without anything
// failing.

export type SaveInstrumentArgs = {
  teacherId: string;
  kind: PayoutInstrumentKind;
  enabled: boolean;
  accountHolder: string | null;
  wiseHandle?: string | null;
  wiseEmail?: string | null;
};

type SaveInstrumentClient = Pick<PrismaClient, "teacherPayoutInstrument" | "teacher">;

const READINESS_SELECT = {
  kind: true,
  enabled: true,
  wiseHandle: true,
} as const satisfies Prisma.TeacherPayoutInstrumentSelect;

export async function saveTeacherInstrument(
  prisma: SaveInstrumentClient,
  args: SaveInstrumentArgs,
): Promise<void> {
  const { teacherId, kind, ...rest } = args;

  // An instrument that isn't fully filled in cannot be enabled, whatever the
  // caller asked for. Two reasons this is enforced here rather than only in
  // the Zod schemas: it is the last gate before the write, so no future caller
  // can skip it; and `HAS_PAYOUT_RAIL_WHERE`'s SQL translation relies on
  // "enabled implies complete" to stay equivalent to the JS predicate, which
  // makes this a correctness invariant rather than a nicety.
  const complete = Boolean(rest.wiseHandle);
  const fields = { ...rest, enabled: rest.enabled && complete };

  const existing = await prisma.teacherPayoutInstrument.findUnique({
    where: { teacherId_kind: { teacherId, kind } },
    select: READINESS_SELECT,
  });
  const wasReady = existing !== null && isInstrumentReady(existing);

  // Upsert rather than create-or-update by hand: the row may already exist
  // because an operator connected the Wise API before the teacher ever opened
  // the settings page (see lib/wise/credentials.ts). `update` lists only the
  // form's own fields, so saving the form can never clear a live API
  // connection.
  const saved = await prisma.teacherPayoutInstrument.upsert({
    where: { teacherId_kind: { teacherId, kind } },
    create: { teacherId, kind, ...fields },
    update: fields,
    select: READINESS_SELECT,
  });

  // Fire once, only on the transition into a usable instrument — not on every
  // save of an already-configured one (mirrors the Stripe rail's false→true
  // gate). `rail` stays an explicit property rather than a literal so the
  // existing activation funnel keeps its dimension; D-145 removed the only
  // kind that ever emitted anything other than `wise`.
  if (!wasReady && isInstrumentReady(saved)) {
    trackServerEvent({
      name: "payout_rail_connected",
      distinctId: teacherId,
      properties: { teacherId, rail: "wise" },
    });
    await flushAnalytics();
    await maybeEmitMarketplaceReady(prisma, teacherId);
  }
}
