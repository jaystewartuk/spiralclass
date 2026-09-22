import type { PrismaClient } from "@prisma/client";
import type { CallMaterial, MaterialAttachmentKind } from "@spiralclass/shared";
import { materialFileKind, studentCallMaterial } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { materialSendTimeElapsed } from "@/lib/materials/timing";
import { getStorageProvider } from "@/lib/storage/provider";
import { pickMaterialsUrl } from "@/lib/storage/signed-urls";

// The materials shown inside the in-call viewer for a single class (booking).
// Both the video-call surfaces open this list so a teacher or student can pull
// a material up ON the call and view it without leaving — content renders
// natively (Markdown `body`), a PDF or image file renders in the same viewer
// (`fileKind`), and everything else opens externally.
//
// Scope is deliberately THIS booking only (not the student's whole library):
// the two attachment sources a class actually carries —
//   * booking-scoped rows  (LibraryMaterial.bookingId, any kind incl. content)
//   * attached library items (BookingLibraryMaterial)
// — which is exactly "the material for this class". Unlike getStudentLibraryView
// we do NOT filter out `body`-bearing rows: content is the primary thing the
// call viewer renders inline.
//
// AUDIENCE IS ONE PARAMETER, NOT SEVERAL BOOLEANS. Two independent things
// differ between the teacher's copy and the student's, and they are the same
// question asked twice:
//   * WHICH materials — the teacher sees everything attached, the student only
//     what has been released (the send-timing gate), mirroring the class-source
//     gate in getStudentLibraryView so the call can't leak a not-yet-sent
//     material.
//   * HOW MUCH OF EACH — the teacher's copy keeps the `> [!answer]` callouts;
//     the student's has them cut out (studentCallMaterial). The renderers
//     collapse answers behind a "Show answer" toggle, which is presentation and
//     not a boundary: whatever this function returns for a student is in her
//     RSC payload, one devtools panel away. So the cut
//     is made here, server-side, before the bytes are ever serialized to her.
// They took a boolean each until a student's in-call payload shipped with every
// solution in it — passing the audience once is what makes that unrepresentable.
//
// Injectable deps keep the mapping (kind resolution, send-time gate, URL
// minting) unit-testable without a database, same pattern as getStudentLibraryView.
export type CallMaterialsDeps = {
  db: PrismaClient;
  mintUrl: (m: { storagePath: string | null; linkUrl: string | null }) => Promise<string | null>;
  now: Date;
};

const MATERIAL_SELECT = {
  id: true,
  label: true,
  storagePath: true,
  linkUrl: true,
  body: true,
} as const;

type MaterialRow = {
  id: string;
  label: string | null;
  storagePath: string | null;
  linkUrl: string | null;
  body: string | null;
};

function kindOf(m: MaterialRow): MaterialAttachmentKind {
  if (m.body != null && !m.storagePath && !m.linkUrl) return "content";
  return m.storagePath ? "file" : "link";
}

/** Who is going to look at this list. `"student"` gates BOTH the send-timing
 * filter and the answer-key strip; `"teacher"` gates neither. */
export type CallMaterialsAudience = "teacher" | "student";

export async function getCallMaterials(
  bookingId: string,
  opts: { audience: CallMaterialsAudience },
  deps?: Partial<CallMaterialsDeps>,
): Promise<CallMaterial[]> {
  const db = deps?.db ?? prisma;
  const now = deps?.now ?? new Date();
  const isStudent = opts.audience === "student";

  const booking = await db.booking.findFirst({
    where: { id: bookingId },
    select: {
      scheduledStart: true,
      materials: {
        where: { archived: false },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { ...MATERIAL_SELECT, sendTiming: true },
      },
      libraryMaterials: {
        orderBy: { attachedAt: "asc" },
        select: { sendTiming: true, material: { select: MATERIAL_SELECT } },
      },
    },
  });
  if (!booking) return [];

  // Flatten both attachment sources into (row, sendTiming) pairs, applying the
  // student send-time gate when asked. A row released to nobody yet is simply
  // absent from the student's list.
  type Pair = { m: MaterialRow; sendTiming: (typeof booking.materials)[number]["sendTiming"] };
  const pairs: Pair[] = [];
  for (const m of booking.materials) pairs.push({ m, sendTiming: m.sendTiming });
  for (const a of booking.libraryMaterials) pairs.push({ m: a.material, sendTiming: a.sendTiming });

  const released = pairs.filter(
    ({ sendTiming }) =>
      !isStudent || materialSendTimeElapsed(sendTiming, booking.scheduledStart, now),
  );

  let mintUrl = deps?.mintUrl;
  if (!mintUrl) {
    // Only spin up a storage client if some file-backed row is actually present.
    const anyFile = released.some(({ m }) => m.storagePath);
    const storage = anyFile ? getStorageProvider() : null;
    mintUrl = (m) => pickMaterialsUrl(storage, m);
  }

  const out: CallMaterial[] = [];
  const seen = new Set<string>();
  for (const { m } of released) {
    // The same library item could be attached twice via different paths; keep
    // the first occurrence so the picker has no duplicates.
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const kind = kindOf(m);
    const isContent = kind === "content";
    const material: CallMaterial = {
      id: m.id,
      label: m.label,
      kind,
      body: isContent ? m.body : null,
      viewUrl: isContent ? null : await mintUrl({ storagePath: m.storagePath, linkUrl: m.linkUrl }),
      // Read off the STORED path, not the minted URL: a signed URL carries a
      // query string, and a link-kind row carries a URL the teacher pasted
      // (whose ".pdf" would be a cross-origin document this app cannot fetch).
      fileKind: kind === "file" ? materialFileKind(m.storagePath) : null,
    };
    out.push(isStudent ? studentCallMaterial(material) : material);
  }
  return out;
}
