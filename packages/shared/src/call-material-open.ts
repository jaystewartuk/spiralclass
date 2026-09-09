// The "open this material for the other participant" data-channel protocol
// (teacher-materials-flexibility redesign). Mirrors captions.ts's shape
// exactly — one shared, dependency-free wire definition so web and mobile
// can't drift, encoded as JSON over LiveKit's reliable data channel under a
// dedicated topic.
//
// This is deliberately NOT a "push an id, look it up locally" protocol like
// caption lines are. The receiver's own materials list is scoped to what's
// already attached/released to this booking (applySendTiming server-side) —
// a teacher's full library item she hasn't assigned to today's lesson yet
// would not resolve there. Instead the full CallMaterial the teacher is
// already authorized to see (it's HER library) travels over the wire, same
// trust model as screen-sharing arbitrary content to the other live
// participant: the sender is a real, token-authenticated participant in this
// same 1:1 room, choosing to share something from her own account, not an
// untrusted third party.
//
// `for` (see captions.ts's note): required on every message so a receiver
// only ever acts on one addressed to itself, even if a non-human participant
// (e.g. the captions Agent) is ever in the room.
//
// ANSWER KEYS NEVER RIDE THIS CHANNEL. The trust model above covers "may the
// receiver see this material at all" — it does NOT cover "may the receiver see
// the SOLUTIONS in it", and the answer is no: the addressee is always the
// student. The teacher drives what the student looks at, and the student has
// no send affordance on either client (web gates the panel on
// `role !== "student"`, mobile on `isTeacher`), so every packet on this topic
// is teacher -> student. So the message carries the STUDENT COPY by
// construction: `encodeCallMaterialOpen` strips the answer key before the
// bytes leave the sender, and `decodeCallMaterialOpen` strips again on
// arrival. The second strip is not belt-and-braces theatre — web and mobile
// shipped independently (mobile builds and OTA updates were a
// separate manual step), so a teacher still running an older mobile build
// keeps publishing unstripped bodies for as long as that build lives, and the
// receiver is the only party that can guarantee what its own user sees.
//
// If a future change ever lets the STUDENT open a material on the TEACHER's
// screen, this premise is what breaks (she would receive a stripped copy of
// her own material) — revisit here, not at the call sites.
//
// THE STRIP IS A BODY RULE, AND FILES NOW RIDE THIS CHANNEL TOO. A PDF or an
// image the teacher pushes travels as a signed URL to opaque bytes: there is
// no `> [!answer]` structure inside it to cut, and this module will not
// pretend otherwise by returning a "stripped" file. What holds the line
// instead is that a file only ever reaches the student when the teacher picks
// "for the student"/"for both" for that one file, on that one pick — the same
// deliberate act as sharing her screen, and the same thing she was already
// doing out loud. A material whose answers she wants held back has to be
// native content, where the cut is structural. Said in the product docs too
// (docs/features/live-calls-video.md, "Materials on the call"), because a rule
// that only exists in a comment is one a surface can be built without.

import type { CallMaterial } from "./api";
import { studentCallMaterial } from "./call-material";

export const CALL_MATERIAL_OPEN_TOPIC = "call-material-open";

export type CallMaterialOpenMessage = {
  // The LiveKit participant identity this open request is addressed to.
  for: string;
  material: CallMaterial;
};

export function encodeCallMaterialOpen(msg: CallMaterialOpenMessage): Uint8Array<ArrayBuffer> {
  // The answer key is cut HERE, not at the call sites: a sender cannot forget
  // it, and the answer bytes never exist in a packet on the wire (LiveKit
  // relays through its SFU) let alone in the receiver's memory.
  const wire: CallMaterialOpenMessage = {
    for: msg.for,
    material: studentCallMaterial(msg.material),
  };
  return new TextEncoder().encode(JSON.stringify(wire)) as Uint8Array<ArrayBuffer>;
}

// Defensive on every field, same reasoning as decodeCaption: a malformed or
// foreign packet on the channel degrades to "ignore", never a throw inside
// the DataReceived handler.
export function decodeCallMaterialOpen(bytes: Uint8Array): CallMaterialOpenMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.for !== "string" || obj.for.length === 0) return null;
  const m = obj.material as Record<string, unknown> | undefined;
  if (typeof m !== "object" || m === null) return null;
  if (typeof m.id !== "string" || m.id.length === 0) return null;
  if (m.kind !== "content" && m.kind !== "file" && m.kind !== "link") return null;
  if (typeof m.label !== "string" && m.label !== null) return null;
  if (typeof m.body !== "string" && m.body !== null) return null;
  if (typeof m.viewUrl !== "string" && m.viewUrl !== null) return null;
  // An unknown/absent fileKind degrades to "other" rather than dropping the
  // packet: the material still opens, just outside the call, which is exactly
  // what every file did before this field existed.
  const fileKind =
    m.fileKind === "pdf" || m.fileKind === "image" || m.fileKind === "other" ? m.fileKind : null;
  // Stripped again on arrival — see the header: an older sender build (or
  // anything else that can put bytes on this topic) does not get to decide what
  // this client's user is shown. The strip parses the body, so it is the one
  // step here that runs non-trivial logic over attacker-shaped input; a throw
  // degrades to "drop the packet" like every other malformed case above, and
  // NEVER to "use the body as sent" — failing open would hand over the exact
  // bytes this function exists to remove.
  let material: CallMaterial;
  try {
    material = studentCallMaterial({
      id: m.id,
      kind: m.kind,
      label: (m.label as string | null) ?? null,
      body: (m.body as string | null) ?? null,
      viewUrl: (m.viewUrl as string | null) ?? null,
      fileKind,
    });
  } catch {
    return null;
  }
  return { for: obj.for, material };
}
