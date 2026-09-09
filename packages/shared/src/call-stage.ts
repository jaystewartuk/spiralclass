// Pure layout logic for the in-class "stage" (the main video
// region), shared by the web ClassCall and the mobile NativeCall so the two
// platforms can't drift. The component owns the LiveKit wiring and the actual
// rendering; this owns the single decision "given whether a material is open
// and whether the other participant is present, what fills the stage and does
// the other participant show as a small picture-in-picture tile".
//
// The point of the PiP: when someone opens a material it fills the stage in
// place of the OTHER participant's video (the material takes their place). Left
// alone that hides the other person entirely — a teacher showing material can
// no longer see the student at all. So while a material is open we keep the
// other participant visible as a small corner tile, like the self-view, so
// each side can still glance at the other while looking at the content.

// "local" (added for tap-to-swap, WHATSAPP_VIDEO_UX) is the mirror of
// "remote": the LOCAL camera fills the stage instead, and the other
// participant becomes the floating tile (remotePip) — the same trade every
// group-call-style UI does with exactly two tiles, so a future >2-participant
// stage can extend this union rather than replace it.
export type CallStageMain = "material" | "remote" | "local" | "waiting";

export type CallStageLayout = {
  // What fills the main stage region.
  main: CallStageMain;
  // Whether the remote (other) participant renders as a small PiP tile
  // instead of (or in addition to) the self-view — true while a material is
  // open (over the content) OR while the stage is swapped (over the self-view's
  // usual corner). Only ever true when the other participant is actually
  // present — otherwise the tile would be an empty box.
  remotePip: boolean;
};

export function resolveCallStage(input: {
  // A `content` material is open in the in-call viewer.
  materialOpen: boolean;
  // The other participant is connected with a (camera) video track to show.
  hasRemote: boolean;
  // Tap-to-swap (WhatsApp-style): the user tapped the self-view to make it
  // the main stage. Ignored while a material is open — material always wins
  // the stage, and swapping into it makes no sense while looking at content —
  // so a caller can leave `swapped` on across a material open/close without
  // needing to also clear it itself.
  swapped?: boolean;
}): CallStageLayout {
  if (input.materialOpen) {
    return { main: "material", remotePip: input.hasRemote };
  }
  if (!input.hasRemote) return { main: "waiting", remotePip: false };
  if (input.swapped) return { main: "local", remotePip: true };
  return { main: "remote", remotePip: false };
}
