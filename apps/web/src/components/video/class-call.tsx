"use client";

import { paletteDark } from "@spiralclass/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type LocalTrackPublication,
  type TrackPublication,
  type Participant,
} from "livekit-client";
import {
  Bookmark,
  Captions,
  Circle,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  MonitorX,
  PhoneOff,
  PictureInPicture2,
  Square,
  SwitchCamera,
  Video,
  VideoOff,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { usePostHog } from "posthog-js/react";
import type { CallGrant } from "@/lib/video/provider";
import type { NudgeResult } from "@/lib/video/nudge";
import {
  callConnectionKey,
  withConnectTimeout,
  CallConnectTimeoutError,
  CONNECTING_ESCAPE_HATCH_MS,
} from "@/lib/video/call-connection";
import { startCallRecording, stopCallRecording } from "@/app/actions/call-recording";
import { useCaptionFeed, useRoomCaptionsEnabled } from "@/lib/captions/use-caption-feed";
import { useCaptionPreferences } from "@/lib/captions/use-caption-preferences";
import {
  CAPTIONS_NOTICE_STORAGE_KEY,
  LEGACY_CAPTIONS_NOTICE_STORAGE_KEY,
  parseCaptionsNoticeSeen,
} from "@/lib/captions/notice";
import { CaptionBand, CaptionTranscript } from "./caption-band";
import { useT } from "@/components/locale-provider";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";
import {
  resolveCallStage,
  FLOATING_CALL_WIDTH,
  FLOATING_CALL_HEIGHT,
  FLOATING_CALL_MARGIN,
  floatingCornerPosition,
  snapToNearestCorner,
  CALL_MATERIAL_OPEN_TOPIC,
  encodeCallMaterialOpen,
  decodeCallMaterialOpen,
  humanRemotes,
  clampSelfViewPosition,
  isTapGesture,
  type CallMaterial,
  type FloatingBounds,
  type FloatingPosition,
  type SelfViewBounds,
  type SelfViewPosition,
} from "@spiralclass/shared";
import { CallControlsDrawer } from "./call-controls-drawer";
import { CallMaterialsPanel, CallMaterialViewer } from "./call-materials-panel";
import {
  computeStageTileStyle,
  resolveTileRole,
  isFloatingRole,
  initialFloatingTilePosition,
  type StageTileRole,
} from "@/lib/video/stage-layout";

// The in-class call surface (live-notes-panel.md step 3). A full-screen LiveKit
// room with the live-notes panel overlaid on top — the whole point of owning the
// call: the teacher's cues (or the student's instructions) sit over the video
// instead of in a separate window. Provider-agnostic above this line; this
// component only knows it was handed a url + token.
//
// Media is browser-only and can't run in CI — the connection logic follows the
// livekit-client API and is verified by typecheck; real-device QA happens with
// LiveKit keys set.
//
// The floating tiles' geometry (self-view/remote-PiP size, the swap
// animation, the minimized bubble's corner-snap) all live in
// lib/video/stage-layout.ts and @spiralclass/shared's floating-call.ts —
// pure functions, unit-tested there, so this component only wires them to
// the actual LiveKit tracks and DOM refs.

// The Document Picture-in-Picture API (window.documentPictureInPicture) isn't
// in TS's lib.dom.d.ts yet (Chrome-only, still a Working Draft) — this is the
// minimal shape this file actually calls, kept local rather than reaching for
// an `any` cast at every use site.
type DocumentPictureInPicture = {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
};
function getDocumentPictureInPicture(): DocumentPictureInPicture | undefined {
  return (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture;
}

// Persisted once this browser has seen the captions privacy notice (below) —
// every enable after that gets only a brief toast, matching item 5 of the
// video-call UX redesign (a permanent overlay line was fine, but the ask was
// specifically to show the full explanation only once and dismiss it for
// good after that). The key and its pre-D-138 spelling live in
// @/lib/captions/notice, which explains why the old one is still read.

export function ClassCall({
  grant,
  backHref,
  overlay,
  canRecord,
  canCaption,
  captionsConsentMissing,
  bookingId,
  role,
  scheduledStartAt,
  materials = [],
  canBrowseLibrary,
  onNudge,
  onBookmark,
  chatHref,
  onLeave,
}: {
  grant: CallGrant;
  backHref: string;
  // Who THIS viewer is on this call (teacher/student page render separately,
  // so the caller always knows). Attached to every call-analytics event
  // below so a funnel can
  // split by role without joining back to the Booking row.
  role?: "teacher" | "student";
  // ISO timestamp of the booking's scheduled start — used only to compute
  // minutesBeforeStart on the join analytics event below.
  scheduledStartAt?: string;
  // Chat thread with the other party (D-… go-to-chat, WhatsApp parity).
  // Present → a Message control shows in the controls row; tapping it
  // minimizes the call (so it keeps running) and navigates there. Absent →
  // no button.
  chatHref?: string;
  // Called when the user actually hangs up (Leave), in addition to this
  // component's own router.push(backHref). Wired by CallSessionOverlay to
  // clear the root-level call session — without it the session would think
  // the call was still active after the user left it.
  onLeave?: () => void;
  overlay?: React.ReactNode;
  // Teacher-only: shows a Record/Stop control. The recording itself runs on the
  // server (LiveKit Egress via the call-recording actions); this just toggles it.
  canRecord?: boolean;
  // Teacher-only: shows the single Subtitles toggle for the call (D-27 —
  // "teacher-toggled" from the start; captions were briefly bidirectional
  // with each side controlling its own independent toggle, which is what let
  // the two flap/race against each other — see room-worker.ts's
  // captions-toggle.ts). The student never gets this control; her own call
  // page simply never sets this prop. Her own speech is still only ever
  // transcribed if she's separately consented (below) — the teacher's switch
  // can turn HER audio-forwarding on, but can't bypass her consent gate.
  canCaption?: boolean;
  // Student-only: true when captions are enabled/available room-wide but SHE
  // hasn't consented yet, so her own speech won't be transcribed for the
  // teacher even while the teacher's toggle is on
  // (the captions architecture review P0) — worth explaining
  // rather than silently doing nothing.
  captionsConsentMissing?: boolean;
  bookingId?: string;
  // The class's materials, shown in the in-call viewer. The teacher gets every
  // attached item; the student gets only released ones (resolved server-side in
  // getCallMaterials). Empty → no Materials control (unless canBrowseLibrary).
  materials?: CallMaterial[];
  // Teacher-only: adds a "My library" tab to the Materials sheet so she can
  // reach her whole reusable library, not just what's attached to this class.
  // Never set on the student call page — students keep seeing only class
  // materials (call-library-browser.tsx's endpoints are teacher-gated too).
  canBrowseLibrary?: boolean;
  // Nudge the other party (D-75). Present when the caller's page wired a
  // role-scoped server action; shown as a button in the waiting-room state so a
  // present user can ping a missing counterparty's devices. Absent → no button.
  onNudge?: () => Promise<NudgeResult>;
  // In-call bookmark (D-97): one tap marks "this moment" for the replay view.
  // Present only on the teacher's call page (server action bound to the
  // booking); absent → no button.
  onBookmark?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}) {
  const t = useT();
  const router = useRouter();
  const posthog = usePostHog();
  // Base properties every call-analytics event carries (docs/architecture/
  // the call-analytics review) — a plain function, not useMemo: these
  // values rarely change and the object is only read at capture time, never
  // used as a dependency.
  const analyticsProps = useCallback(
    (extra?: Record<string, unknown>) => ({ bookingId, role, surface: "web", ...extra }),
    [bookingId, role],
  );
  // minutesBeforeStart on the join event: this product has no
  // separate join/waiting-room step (mounting this component IS the join
  // gesture), and the call page re-renders on unrelated Server Actions
  // (e.g. pressing Record triggers revalidatePath) — so this is read once
  // via a ref rather than fired from the server page render, which would
  // have double-counted every such re-render as a fresh "page opened".
  const minutesBeforeStart = useRef(
    scheduledStartAt
      ? Math.round((new Date(scheduledStartAt).getTime() - Date.now()) / 60_000)
      : undefined,
  ).current;
  // Timing refs for the connect/reconnect/call-duration metrics below. Refs,
  // not state — they're read at event-fire time only and must never trigger
  // a re-render.
  const connectStartedAtRef = useRef<number | null>(null);
  const connectedAtRef = useRef<number | null>(null);
  const reconnectStartedAtRef = useRef<number | null>(null);
  const captionsStartedAtRef = useRef<number | null>(null);
  const screenShareStartedAtRef = useRef<number | null>(null);
  // Set just before a deliberate hang-up (leave()) so the RoomEvent.Disconnected
  // handler can tell "the user left" apart from an unexpected drop — LiveKit
  // fires the same event either way.
  const leavingRef = useRef(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLDivElement>(null);
  // Screen share (local or remote — only one side shares at a time in this
  // 1:1 app) fills the main stage the same way a material does; this is the
  // container it's attached into.
  const screenShareRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);
  // The live Room, mirrored into state (not just the ref) so the caption hooks
  // re-run once it's connected. Null until connected / after teardown.
  const [room, setRoom] = useState<Room | null>(null);

  const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
  // Start false — flipped true only once the track actually publishes, so the
  // controls reflect reality when a permission is denied (or, on mobile, when
  // the auto-start fails for want of a tap).
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  // How many other people are in the room. 0 → the user is alone; we say so
  // instead of showing a confusing black void.
  const [remoteCount, setRemoteCount] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  // Recording state mirrors LiveKit's own room.isRecording, pushed to BOTH
  // participants via RecordingStatusChanged — that's the visible-consent surface,
  // so neither side is ever recorded silently. `recordPending` debounces the
  // teacher's toggle while the server action runs.
  const [recording, setRecording] = useState(false);
  const [recordPending, setRecordPending] = useState(false);
  // Surfaced when a Record/Stop toggle is rejected, so it's never a silent no-op.
  const [recordError, setRecordError] = useState<string | null>(null);
  // In-call bookmark (D-97) — `bookmarked` flashes true briefly after a
  // successful tap as the only feedback; `bookmarkPending` debounces repeats.
  const [bookmarked, setBookmarked] = useState(false);
  const [bookmarkPending, setBookmarkPending] = useState(false);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  // True while LiveKit is auto-reconnecting after a transient drop (common on
  // mobile networks). We surface a banner instead of leaving the call frozen
  // and silent; LiveKit fires Disconnected (→ the error UI) only if it gives up.
  const [reconnecting, setReconnecting] = useState(false);
  // Teacher's subtitles toggle (D-27). Ephemeral like the mic/record controls —
  // turning it on starts captioning her speech for the student; off clears it.
  const [captionsOn, setCaptionsOn] = useState(false);
  // First-time captions privacy notice — shown as an in-video card only until
  // dismissed once (see CAPTIONS_NOTICE_STORAGE_KEY); every later enable just toasts.
  const [showCaptionsNotice, setShowCaptionsNotice] = useState(false);
  // Whether THIS device is currently publishing its screen. No moderation
  // asymmetry — either party can share (token grants are identical, see
  // mintToken). Only one screen-share track is ever attached into
  // screenShareRef at a time (own or the other party's).
  const [screenShareOn, setScreenShareOn] = useState(false);
  // Whether the OTHER party is currently sharing their screen. Kept separate
  // from screenShareOn (local-only) so the stage layout reacts to either
  // side sharing — combined into `screenShareActive` below.
  const [remoteScreenShareOn, setRemoteScreenShareOn] = useState(false);
  // True while EITHER side is sharing their screen (only one at a time in
  // this 1:1 app, but the viewer's own screenShareOn and the other party's
  // remoteScreenShareOn are two independent event sources). Declared early
  // (rather than beside `stage` below, where it conceptually belongs) because
  // canSwap/canMinimize need it before their own declarations run.
  const screenShareActive = screenShareOn || remoteScreenShareOn;
  // The material currently open in the in-call viewer, or null. When set, it
  // fills the main area in place of the remote video (the self-view + controls
  // stay). Only `content` materials land here; file/link open externally.
  const [activeMaterial, setActiveMaterial] = useState<CallMaterial | null>(null);
  // Nudge button state (D-75). "sent"/"cooldown" disable the button for a beat
  // so a present user can't spam the missing party's devices; it re-enables so a
  // genuinely-still-waiting user can nudge again.
  const [nudgeState, setNudgeState] = useState<"idle" | "sending" | "sent" | "cooldown" | "error">(
    "idle",
  );

  // Tap-to-swap (WhatsApp-style): tapping the floating self-view swaps it
  // with the main remote view; tapping the (now-floating) remote tile swaps
  // back. Purely a layout flag — resolveCallStage below turns it into which
  // DOM node is "big" vs a floating corner tile, and nothing here ever
  // touches track attachment, so a swap never re-subscribes or interrupts
  // either video.
  const [swapped, setSwapped] = useState(false);

  // Minimized floating call window (WhatsApp-style). `minimized` collapses
  // the full-screen overlay into a small draggable corner bubble showing
  // only the current primary tile (see the render below); `floatingPos` is
  // its last dragged position (null until the user drags it, so it starts
  // snapped to the default bottom-right corner). `dragging` suppresses the
  // position transition while a drag is live so the bubble tracks the
  // pointer 1:1 instead of chasing it through a 220ms easing curve.
  const [minimized, setMinimized] = useState(false);
  const [floatingPos, setFloatingPos] = useState<FloatingPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  // Draggable self-view/remote-PiP tiles. Each floating tile (local self-view,
  // remote PiP in
  // material mode) tracks its own dragged position; null means "hasn't been
  // dragged yet, use the default corner" (see computeStageTileStyle/
  // initialFloatingTilePosition). Reset to null the moment a tile stops
  // floating (swapped to the main stage, or hidden) so the NEXT time it
  // floats again it starts back at its default corner rather than resuming a
  // position that made sense in a different layout.
  const [localTilePos, setLocalTilePos] = useState<SelfViewPosition | null>(null);
  const [remoteTilePos, setRemoteTilePos] = useState<SelfViewPosition | null>(null);
  const [draggingTile, setDraggingTile] = useState<"local" | "remote" | null>(null);
  const tileDragRef = useRef<{
    tile: "local" | "remote";
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    startedAt: number;
  } | null>(null);
  // Height of the bottom controls bar, measured live so a dragged tile is
  // clamped above it (not just above a guessed constant) — the same role
  // `controlsBlockH` plays in mobile's clamp bounds.
  const controlsRef = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);
  useEffect(() => {
    const el = controlsRef.current;
    if (!el || minimized) return;
    const measure = () => setControlsHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [minimized]);
  const tileBounds = useCallback(
    (): SelfViewBounds => ({
      screenW: typeof window === "undefined" ? 400 : window.innerWidth,
      screenH: typeof window === "undefined" ? 800 : window.innerHeight,
      controlsBlockH: controlsHeight,
    }),
    [controlsHeight],
  );
  // Re-clamp both dragged positions whenever the viewport changes size —
  // browser resize, or entering/leaving Fullscreen (which some browsers
  // don't fire a `resize` event for) — so a tile dragged near an edge never
  // ends up stranded off-screen or behind the controls bar after the window
  // changes (item 6/8 of the requirements).
  useEffect(() => {
    const reclamp = () => {
      const bounds = tileBounds();
      setLocalTilePos((p) => (p ? clampSelfViewPosition(p, { dx: 0, dy: 0 }, bounds) : p));
      setRemoteTilePos((p) => (p ? clampSelfViewPosition(p, { dx: 0, dy: 0 }, bounds) : p));
    };
    window.addEventListener("resize", reclamp);
    document.addEventListener("fullscreenchange", reclamp);
    return () => {
      window.removeEventListener("resize", reclamp);
      document.removeEventListener("fullscreenchange", reclamp);
    };
  }, [tileBounds]);

  // Document Picture-in-Picture (native browser PiP — a real always-on-top OS
  // window, separate from the in-page bubble above). Feature-detected in an
  // effect (not inline) so the initial server-rendered markup never depends on
  // `window`. Deliberately does NOT touch remoteRef/localVideoRef or move any
  // existing DOM node into the PiP window — that would desync React's fiber
  // tree from the real DOM the moment anything else in this component
  // re-rendered. Instead PipMirror (below) is a SEPARATE React tree, portaled
  // into the PiP window's own document, with its own fresh <video> elements
  // multi-attached to the same live tracks (livekit-client tracks support
  // attaching to more than one element at once) — so opening/closing PiP can
  // never interrupt or re-subscribe the main call's own video. Audio keeps
  // playing from the main window's existing hidden <audio> element the whole
  // time (minimizing, not unmounting, is what keeps it alive).
  const [pipSupported, setPipSupported] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const pipWindowRef = useRef<Window | null>(null);
  useEffect(() => {
    setPipSupported(typeof window !== "undefined" && "documentPictureInPicture" in window);
  }, []);

  // Camera flip (front/rear, or cycling through whatever video inputs the
  // device exposes — a desktop has no "front/rear" concept, so this just
  // cycles the active videoinput device). `flippingCamera` guards against a
  // rapid double-tap starting a second switch mid-flight; the actual on/off
  // camera state stays reconciled from the live publication elsewhere (see
  // the reconcile effect below) — this only ever changes WHICH device feeds
  // that publication.
  const [flippingCamera, setFlippingCamera] = useState(false);
  const [flipCameraError, setFlipCameraError] = useState(false);
  const [videoInputCount, setVideoInputCount] = useState(0);

  const nudge = useCallback(async () => {
    if (!onNudge || nudgeState === "sending" || nudgeState === "sent" || nudgeState === "cooldown")
      return;
    setNudgeState("sending");
    try {
      const res = await onNudge();
      if (res.ok) {
        setNudgeState("sent");
        setTimeout(() => setNudgeState("idle"), 45_000);
      } else if (res.reason === "cooldown") {
        setNudgeState("cooldown");
        setTimeout(() => setNudgeState("idle"), (res.retryAfterSec ?? 45) * 1000);
      } else {
        // already-present (they just joined) / not-found — the waiting state
        // itself clears when their track arrives, so just reset.
        setNudgeState("idle");
      }
    } catch {
      setNudgeState("error");
      setTimeout(() => setNudgeState("idle"), 4_000);
    }
  }, [onNudge, nudgeState]);

  const leave = useCallback(() => {
    // Best-effort, fire-and-forget: a teacher walking away from the call is
    // not the same as tapping Stop, but recording is only meaningful while
    // someone's actually in the call to be recorded, and the room_finished
    // webhook (finalizeDanglingRecording) is the backstop if this never lands
    // (browser closed outright, network gone). Only the teacher who can
    // record is authorized to stop it server-side — a student's call to this
    // action would just fail harmlessly, so gate on canRecord to skip the
    // wasted request.
    if (canRecord && recording && bookingId) void stopCallRecording(bookingId);
    leavingRef.current = true;
    const durationSeconds = connectedAtRef.current
      ? Math.round((Date.now() - connectedAtRef.current) / 1000)
      : undefined;
    posthog?.capture(
      "call_ended",
      analyticsProps({ durationSeconds, endReason: "left", bothPartiesPresent: remoteCount > 0 }),
    );
    roomRef.current?.disconnect();
    onLeave?.();
    router.push(backHref);
  }, [
    canRecord,
    recording,
    bookingId,
    router,
    backHref,
    onLeave,
    posthog,
    analyticsProps,
    remoteCount,
  ]);

  // The connection is pinned to this key, NOT to grant.token. The call page
  // re-mints a fresh JWT on every server render, and a Server Action like Record
  // calls revalidatePath — which refreshes the current route and hands us a new
  // token string. Reconnecting on that is exactly what dropped the teacher out of
  // the call (black screen + dead caption session) the instant she pressed Record.
  // We connect once per mount and reconnect only on an explicit Retry; the latest
  // grant is read from a ref at connect time so a Retry still uses a fresh token.
  const connKey = callConnectionKey(grant, retryKey);
  const grantRef = useRef(grant);
  useEffect(() => {
    grantRef.current = grant;
  }, [grant]);

  // "This join is taking too long" — drives the Retry/Leave pair inside the
  // connecting state. Keyed on connKey as well as status so an explicit Retry
  // restarts the clock rather than showing the buttons instantly.
  const [connectingStalled, setConnectingStalled] = useState(false);
  useEffect(() => {
    if (status !== "connecting") {
      setConnectingStalled(false);
      return;
    }
    setConnectingStalled(false);
    const timer = setTimeout(() => setConnectingStalled(true), CONNECTING_ESCAPE_HATCH_MS);
    return () => clearTimeout(timer);
  }, [status, connKey]);

  useEffect(() => {
    const { url, token } = grantRef.current;
    // dynacast is OFF on purpose. It only helps a publisher fanning out to many
    // subscribers at different qualities; this is a 1:1 call. Worse, with it on,
    // the SECOND participant subscribing triggers LiveKit's subscribed-quality
    // renegotiation (handleSubscribedQualityUpdate is gated entirely on dynacast),
    // which can restart the local camera track — detaching it from the self-view
    // element and leaving it transparent. adaptiveStream stays on (it's a
    // subscriber-side optimisation and pauses remote video when the tab is hidden).
    const room = new Room({ adaptiveStream: true, dynacast: false });
    roomRef.current = room;
    let cancelled = false;
    // Each connection attempt starts out "not deliberately leaving". Without
    // this reset, a Retry after a timed-out connect (which sets the flag to
    // suppress its own teardown) would inherit it and silently swallow the
    // NEXT genuine unexpected disconnect.
    leavingRef.current = false;

    function attachRemote(track: RemoteTrack) {
      if (!remoteRef.current) return;
      const container = remoteRef.current;
      // A leave+rejoin silently renegotiates the SFU's media sections (see the
      // self-view note below) without always firing a matching TrackUnsubscribed
      // for the OLD element first — so TrackSubscribed can fire again while a
      // stale, now-dead element from the previous subscription is still sitting
      // in the DOM. Since this is a 1:1 call there's ever only one remote
      // audio/video element at a time; clear any stale one of the same kind
      // before attaching the new one so dead elements never pile up and blank
      // out (or silence) a perfectly live track underneath them.
      if (track.kind === Track.Kind.Audio) {
        container.querySelectorAll("audio").forEach((el) => el.remove());
        // Audio: attach so the other person is audible (a hidden <audio> that
        // autoplays). Without this the call is silent.
        const audio = track.attach();
        audio.classList.add("hidden");
        container.appendChild(audio);
        return;
      }
      if (track.kind !== Track.Kind.Video) return;
      // The remote's screen-share video goes into its own stage container,
      // not the camera one — attaching both kinds into the same element
      // would just have the last-attached one clobber the other.
      if (track.source === Track.Source.ScreenShare) {
        if (!screenShareRef.current) return;
        const shareContainer = screenShareRef.current;
        shareContainer.querySelectorAll("video").forEach((el) => el.remove());
        const el = track.attach();
        el.classList.add("h-full", "w-full", "object-contain");
        shareContainer.appendChild(el);
        if (!cancelled) setRemoteScreenShareOn(true);
        return;
      }
      container.querySelectorAll("video").forEach((el) => el.remove());
      const el = track.attach();
      // object-fit itself is controlled by the container's own className below
      // (a `[&>video]:object-*` selector keyed on remoteRole) rather than here,
      // so it stays correct across a tap-to-swap even though this attach only
      // runs once per TrackSubscribed.
      el.classList.add("h-full", "w-full", "rounded-lg");
      container.appendChild(el);
    }

    function syncRemoteCount() {
      // Humans only. `remoteParticipants` includes the captions Agent, and
      // this count drives "is the other person here?" for the waiting-room
      // state, the swap-video affordance and the materials open-choice sheet —
      // all of which were treating an Agent-only room as "they're here".
      if (!cancelled) setRemoteCount(humanRemotes(room.remoteParticipants.values()).length);
    }

    // Both the native "stop sharing" bar and LocalTrackUnpublished can fire
    // for the same stop (see the comment on LocalTrackPublished below) —
    // guard on the start ref so a genuine stop is only ever reported once.
    function reportScreenShareStopped() {
      if (!screenShareStartedAtRef.current) return;
      const durationSeconds = Math.round((Date.now() - screenShareStartedAtRef.current) / 1000);
      screenShareStartedAtRef.current = null;
      posthog?.capture("call_screen_share_stopped", analyticsProps({ durationSeconds }));
    }

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => attachRemote(track))
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
        if (track.source === Track.Source.ScreenShare && !cancelled) {
          setRemoteScreenShareOn(false);
        }
      })
      .on(RoomEvent.ParticipantConnected, syncRemoteCount)
      .on(RoomEvent.ParticipantDisconnected, syncRemoteCount)
      .on(RoomEvent.RecordingStatusChanged, (active: boolean) => {
        if (!cancelled) setRecording(active);
      })
      // Covers BOTH how a local screen share can start/stop: our own toggle
      // button, and the browser's native "stop sharing" bar/toolbar (which
      // stops the MediaStreamTrack directly and never goes through our
      // toggle at all) — either way LiveKit unpublishes the track and fires
      // this, so the button state can't drift from what's actually live.
      .on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
        if (publication.source !== Track.Source.ScreenShare) return;
        if (!cancelled) setScreenShareOn(true);
        screenShareStartedAtRef.current = Date.now();
        posthog?.capture("call_screen_share_started", analyticsProps());
        const el = screenShareRef.current;
        const videoTrack = publication.videoTrack;
        if (el && videoTrack) {
          el.querySelectorAll("video").forEach((existing) => existing.remove());
          const attached = videoTrack.attach();
          attached.classList.add("h-full", "w-full", "object-contain");
          el.appendChild(attached);
        }
        // Belt-and-suspenders for the native "stop sharing" affordance: some
        // browsers stop the underlying track without LiveKit ever observing
        // it fast enough to fire LocalTrackUnpublished promptly. Listening
        // to the track's own `ended` directly means the button can't get
        // stuck showing "sharing" after the browser's own control stopped it.
        videoTrack?.mediaStreamTrack.addEventListener(
          "ended",
          () => {
            if (!cancelled) setScreenShareOn(false);
            reportScreenShareStopped();
          },
          { once: true },
        );
      })
      .on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
        if (publication.source !== Track.Source.ScreenShare) return;
        if (!cancelled) setScreenShareOn(false);
        reportScreenShareStopped();
        publication.videoTrack?.detach().forEach((el) => el.remove());
      })
      // Transient drop → LiveKit reconnects on its own; show a banner meanwhile.
      .on(RoomEvent.Reconnecting, () => {
        if (cancelled) return;
        setReconnecting(true);
        reconnectStartedAtRef.current = Date.now();
        posthog?.capture("call_reconnect_attempted", analyticsProps());
      })
      .on(RoomEvent.Reconnected, () => {
        if (cancelled) return;
        setReconnecting(false);
        const outageMs = reconnectStartedAtRef.current
          ? Date.now() - reconnectStartedAtRef.current
          : undefined;
        reconnectStartedAtRef.current = null;
        posthog?.capture("call_reconnected", analyticsProps({ outageMs }));
      })
      .on(RoomEvent.Disconnected, () => {
        if (cancelled) return;
        setReconnecting(false);
        setStatus("error");
        // A deliberate leave() already fired call_ended and set leavingRef —
        // don't double-report it as a failure. Otherwise this is either a
        // reconnect LiveKit gave up on, or a fresh drop with no prior
        // Reconnecting at all.
        if (!leavingRef.current) {
          if (reconnectStartedAtRef.current) {
            posthog?.capture("call_reconnect_failed", analyticsProps());
            reconnectStartedAtRef.current = null;
          } else {
            posthog?.capture("call_disconnected_unexpectedly", analyticsProps());
          }
        }
      });

    (async () => {
      // This product has no separate join/waiting-room step (docs/architecture/
      // the call-analytics review) — mounting the call page IS the join
      // gesture, so the funnel's top-of-funnel event fires right here rather
      // than behind a button that doesn't exist.
      posthog?.capture("call_join_clicked", analyticsProps({ minutesBeforeStart }));
      connectStartedAtRef.current = Date.now();
      posthog?.capture("call_connection_started", analyticsProps());

      // 1) Connect. Only a failure here is a fatal "couldn't connect".
      // Bounded by withConnectTimeout because a connect that never settles is a
      // real, observed failure mode (see CALL_CONNECT_TIMEOUT_MS) and used to
      // leave `status` pinned on "connecting" forever, which renders a spinner
      // with no Retry beside it.
      try {
        await withConnectTimeout(room.connect(url, token));
      } catch (err) {
        const timedOut = err instanceof CallConnectTimeoutError;
        // The underlying connect may still be in flight inside livekit-client.
        // Tear it down so it can't quietly finish and leave this participant
        // live in the room — visible and audible to the other party — while
        // this client is showing the error screen. leavingRef suppresses the
        // resulting Disconnected from being reported as an unexpected drop:
        // this teardown is ours, and the failure is already reported below.
        if (timedOut) {
          leavingRef.current = true;
          room.disconnect();
        }
        if (!cancelled) {
          setStatus("error");
          posthog?.capture(
            "call_connection_failed",
            analyticsProps({ reason: timedOut ? "timeout" : "error" }),
          );
        }
        return;
      }
      if (cancelled) return;
      setStatus("connected");
      setRoom(room);
      syncRemoteCount();
      setRecording(room.isRecording);
      connectedAtRef.current = Date.now();
      const msToConnect = connectStartedAtRef.current
        ? connectedAtRef.current - connectStartedAtRef.current
        : undefined;
      posthog?.capture("call_connected", analyticsProps({ msToConnect }));

      // 2) Try to publish camera + mic. Best-effort and silent on failure: on
      // desktop this just works; on mobile the browser usually needs a tap
      // before it grants the camera, so this rejects and the user turns media
      // on with the Camera/Mic buttons instead (which provide that tap). Either
      // way a failure must never tear down a working room or escape as an
      // unhandled rejection — and the "media is off" hint below tells the user
      // exactly what to do, regardless of why the auto-start didn't take.
      posthog?.capture("microphone_permission_requested", analyticsProps());
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        if (!cancelled) {
          setMicOn(true);
          posthog?.capture("microphone_permission_granted", analyticsProps());
          posthog?.capture("call_local_audio_enabled", analyticsProps({ auto: true }));
        }
      } catch {
        /* stays off; user taps Mic to enable */
        posthog?.capture(
          "microphone_permission_denied",
          analyticsProps({ reason: "auto-publish" }),
        );
      }
      posthog?.capture("camera_permission_requested", analyticsProps());
      try {
        await room.localParticipant.setCameraEnabled(true);
        if (cancelled) return;
        setCamOn(true);
        posthog?.capture("camera_permission_granted", analyticsProps());
        posthog?.capture("call_local_video_enabled", analyticsProps({ auto: true }));
        const cam = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (cam?.videoTrack && localVideoRef.current) cam.videoTrack.attach(localVideoRef.current);
      } catch {
        /* stays off; user taps Camera to enable */
        posthog?.capture("camera_permission_denied", analyticsProps({ reason: "auto-publish" }));
      }
    })();

    return () => {
      cancelled = true;
      room.disconnect();
      roomRef.current = null;
      setRoom(null);
    };
    // Pinned to connKey (media-server URL + retry), never to the volatile token —
    // see the note above and lib/video/call-connection.ts.
  }, [connKey]);

  // Keep the self-view bound to the CURRENT local camera track. Attaching once
  // at connect time is fragile: LiveKit can swap the underlying track out from
  // under us (a device change, a reconnect, or a mid-call restart), and the
  // one-shot attach was left pointing at the old, stopped track — so the
  // self-view went transparent. Re-attach on every event that can mean the
  // publication changed: (re)publish, mute/unmute (both fire for local AND
  // remote — filtered to the local participant here, since the earlier version
  // only listened for Unmuted and missed Muted), and a full reconnect (the SFU
  // can renegotiate the local publication without re-firing LocalTrackPublished,
  // which is exactly the kind of renegotiation a second participant joining can
  // trigger). Reading the live publication each time picks up a replaced track
  // object too. This mirrors what the mobile <VideoTrack> does reactively.
  //
  // That renegotiation is actually a SILENT one: a participant joining OR
  // leaving-then-rejoining makes the server renegotiate media sections, which
  // the client handles via its own SDP offer/answer — firing no RoomEvent at
  // all (not LocalTrackPublished, not a mute event, not Reconnected). Explicit
  // listeners below cover the common triggers, and a poll is defense-in-depth
  // against whatever they don't catch — attach() is a real no-op when the
  // element is already bound to the current track (livekit-client's
  // attachToElement only reassigns srcObject if the track object actually
  // differs — see its source), so polling costs nothing when there's nothing
  // to fix.
  //
  // Crucially, `reconcile` below recomputes camOn/micOn from the LIVE
  // publication on every call, rather than only flipping them in response to
  // a `TrackMuted`/`TrackUnmuted` event. A leave+rejoin's renegotiation isn't
  // guaranteed to fire those two symmetrically (a republish/restart can emit
  // a mute without ever emitting the matching unmute) — the previous version
  // tracked mute state as an event-driven delta, so a lone stray Muted left
  // camOn stuck false FOREVER, hiding the self-view (its `hidden` class is
  // driven straight off camOn) even once the poll had already re-attached a
  // perfectly live track underneath it. Deriving both the attach AND the
  // on/off state from `getTrackPublication()`'s actual current state every
  // time can't get stuck: whatever LiveKit says right now IS what renders,
  // on every poll tick, not just on the events that happened to fire.
  useEffect(() => {
    if (!room) return;
    const reconcile = () => {
      const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      setCamOn(Boolean(camPub && !camPub.isMuted));
      setMicOn(Boolean(micPub && !micPub.isMuted));
      const el = localVideoRef.current;
      if (camPub?.videoTrack && el) camPub.videoTrack.attach(el);
    };
    const onParticipantChanged = () => {
      reconcile();
      pendingResyncs.push(setTimeout(reconcile, 1500));
    };
    const onTrackMuteChange = (_pub: TrackPublication, participant: Participant) => {
      if (participant.isLocal) reconcile();
    };
    const pendingResyncs: ReturnType<typeof setTimeout>[] = [];
    reconcile();
    room
      .on(RoomEvent.LocalTrackPublished, reconcile)
      .on(RoomEvent.TrackMuted, onTrackMuteChange)
      .on(RoomEvent.TrackUnmuted, onTrackMuteChange)
      .on(RoomEvent.Reconnected, reconcile)
      .on(RoomEvent.ParticipantConnected, onParticipantChanged)
      .on(RoomEvent.ParticipantDisconnected, onParticipantChanged);
    // 2s is often enough to feel instant without running noticeably more
    // than the events above already do in the common case.
    const pollInterval = setInterval(reconcile, 2000);
    return () => {
      clearInterval(pollInterval);
      pendingResyncs.forEach(clearTimeout);
      room
        .off(RoomEvent.LocalTrackPublished, reconcile)
        .off(RoomEvent.TrackMuted, onTrackMuteChange)
        .off(RoomEvent.TrackUnmuted, onTrackMuteChange)
        .off(RoomEvent.Reconnected, reconcile)
        .off(RoomEvent.ParticipantConnected, onParticipantChanged)
        .off(RoomEvent.ParticipantDisconnected, onParticipantChanged);
    };
  }, [room]);

  // Caption wiring: server-side LiveKit Agent (packages/livekit-captions-agent)
  // transcribes/translates both sides and addresses each line to its listener
  // (the protocol's `for` field) — this component only ever receives, it
  // doesn't publish. The teacher's toggle (captionsOn, below) sets a single
  // participant attribute the Agent reads before forwarding EITHER side's
  // audio anywhere (D-27) — not a client-side publish, and not something the
  // student's own instance of this component ever sets.
  const captions = useCaptionFeed(room);
  // The room's switch as seen from EITHER side — the teacher's own toggle
  // state on her screen, and the same flag read off her participant
  // attributes on the student's. See useRoomCaptionsEnabled for why the
  // student needs it (she had no way to know captions were on until a line
  // arrived, which is a second or two of looking like nothing works).
  const roomCaptionsOn = useRoomCaptionsEnabled(room);
  const { prefs: captionPrefs, setPrefs: setCaptionPrefs } = useCaptionPreferences();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  // Resolve a caption's speaker identity to the name the room knows them by.
  // Deliberately not memoized on the participant map: LiveKit mutates it in
  // place, so a memo would hold a stale closure over exactly the moment
  // someone rejoins under a new name.
  const speakerName = useCallback(
    (identity: string): string | null => {
      const r = roomRef.current;
      if (!r) return null;
      if (identity === r.localParticipant?.identity) return r.localParticipant.name ?? null;
      return r.remoteParticipants.get(identity)?.name ?? null;
    },
    // roomRef is a ref; this is stable for the component's life.
    [],
  );

  // Teacher-materials-flexibility (redesign item 6): receive a material the
  // OTHER participant chose to open "for me"/"for both" and open it here too
  // — see packages/shared/call-material-open.ts for the trust model (the
  // sender is the other token-authenticated participant in this same room,
  // sharing something she's already authorized to see; the receiver doesn't
  // re-validate against its own materials list).
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
      if (topic !== CALL_MATERIAL_OPEN_TOPIC) return;
      const msg = decodeCallMaterialOpen(payload);
      if (!msg || msg.for !== room.localParticipant.identity) {
        // Silent by design otherwise (a malformed/foreign packet, or one
        // addressed to someone else) — but this incident (materials sent
        // during a call never appearing, with nothing to investigate
        // afterward) is exactly why the discard itself needs a trace.
        posthog?.capture(
          "call_material_open_ignored",
          analyticsProps({ reason: !msg ? "decode_failed" : "not_addressed_to_me" }),
        );
        return;
      }
      // The receiver may be minimized (e.g. mid-chat via goToChat) when this
      // arrives — activeMaterial alone won't render anything until the call
      // is expanded (see the `activeMaterial && !minimized` gate below).
      setMinimized(false);
      setActiveMaterial(msg.material);
      posthog?.capture("call_material_open_received", analyticsProps());
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, posthog, analyticsProps]);

  // Sends a material to the other participant's screen; returns false when
  // there's nobody in the room to receive it (the caller decides what to do
  // with that — the choice sheet only offers "for student"/"for both" while
  // someone is actually present, so this mainly guards a late departure).
  const sendMaterialToOther = useCallback(
    (material: CallMaterial) => {
      const room = roomRef.current;
      // humanRemotes, not [0]: the captions Agent joins every caption-enabled
      // class room as a real remote participant, and addressing the message to
      // it meant the student never got it — with no error anywhere, since the
      // student correctly ignores a message not addressed to them.
      const other = room ? humanRemotes(room.remoteParticipants.values())[0] : undefined;
      if (!room || !other) {
        posthog?.capture("call_material_open_send_skipped", analyticsProps());
        return false;
      }
      // publishData is fire-and-forget only in the sense that the caller
      // doesn't await it — a rejection (e.g. the reliable data channel not
      // yet re-established after a mid-call reconnect) still needs to be
      // captured, or "sent" fires unconditionally for a packet that never
      // actually left the client, with nothing to investigate afterward.
      room.localParticipant
        .publishData(encodeCallMaterialOpen({ for: other.identity, material }), {
          reliable: true,
          topic: CALL_MATERIAL_OPEN_TOPIC,
        })
        .then(() => {
          posthog?.capture("call_material_open_sent", analyticsProps());
        })
        .catch((error: unknown) => {
          posthog?.capture(
            "call_material_open_send_failed",
            analyticsProps({ error: error instanceof Error ? error.message : String(error) }),
          );
        });
      return true;
    },
    [posthog, analyticsProps],
  );

  // Toggles catch internally: a denied permission is swallowed rather than
  // rejecting (which would surface as an unhandled promise rejection). Tapping
  // a control is the user gesture mobile browsers require, so this is also the
  // path that actually turns media on there.
  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micOn;
    if (next) posthog?.capture("microphone_permission_requested", analyticsProps());
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicOn(next);
      if (next) {
        posthog?.capture("microphone_permission_granted", analyticsProps());
        posthog?.capture("call_local_audio_enabled", analyticsProps({ auto: false }));
      }
    } catch {
      /* permission denied or unavailable — leave the control as-is */
      if (next)
        posthog?.capture("microphone_permission_denied", analyticsProps({ reason: "toggle" }));
      else posthog?.capture("call_audio_device_failed", analyticsProps());
    }
  }, [micOn, posthog, analyticsProps]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !camOn;
    if (next) posthog?.capture("camera_permission_requested", analyticsProps());
    try {
      await room.localParticipant.setCameraEnabled(next);
      setCamOn(next);
      if (next) {
        posthog?.capture("camera_permission_granted", analyticsProps());
        posthog?.capture("call_local_video_enabled", analyticsProps({ auto: false }));
        const cam = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (cam?.videoTrack && localVideoRef.current) cam.videoTrack.attach(localVideoRef.current);
      }
    } catch {
      /* permission denied or unavailable — leave the control as-is */
      if (next) posthog?.capture("camera_permission_denied", analyticsProps({ reason: "toggle" }));
      else posthog?.capture("call_video_device_failed", analyticsProps());
    }
  }, [camOn, posthog, analyticsProps]);

  // Enumerate video input devices so the flip-camera control only shows when
  // there's actually a second camera to switch to (desktops with one webcam,
  // or a locked-down browser, hide it entirely rather than show a button that
  // always no-ops). `devicechange` fires when a USB webcam is plugged/unplugged
  // mid-call. Device labels (and therefore a real front/rear distinction) are
  // only populated once permission was granted at least once, which camOn
  // having ever been true implies — the count itself is visible either way.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refresh = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (!cancelled) {
            setVideoInputCount(devices.filter((d) => d.kind === "videoinput").length);
          }
        })
        .catch(() => {});
    };
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, []);

  // Cycle to the next available camera. Uses livekit-client's
  // switchActiveDevice, which replaces the publication's underlying device
  // in place (no unpublish/republish, no renegotiation) — the call stays
  // connected and mic/speaker/video-enabled state are untouched since none of
  // those are involved. The actual self-view re-render is handled by the
  // existing reconcile effect above (it re-attaches from the live publication
  // on every LocalTrackPublished / 2s poll tick), matching the "never
  // optimistically set camera state" rule the rest of this component follows.
  const flipCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room || flippingCamera) return;
    setFlippingCamera(true);
    setFlipCameraError(false);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      if (cams.length < 2) return;
      const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const currentId = camPub?.videoTrack?.mediaStreamTrack.getSettings().deviceId;
      const currentIndex = currentId ? cams.findIndex((d) => d.deviceId === currentId) : -1;
      const next = cams[(currentIndex + 1) % cams.length];
      await room.switchActiveDevice("videoinput", next.deviceId);
      posthog?.capture(
        "call_device_switched",
        analyticsProps({ kind: "camera", outcome: "success" }),
      );
    } catch {
      // Device busy, permission revoked mid-call, or only one real camera
      // despite two device entries (some browsers list a "default" alias) —
      // the camera stays on whatever it already was, and we say so briefly.
      setFlipCameraError(true);
      posthog?.capture(
        "call_device_switched",
        analyticsProps({ kind: "camera", outcome: "failed" }),
      );
      setTimeout(() => setFlipCameraError(false), 3_000);
    } finally {
      setFlippingCamera(false);
    }
  }, [flippingCamera, posthog, analyticsProps]);

  // Tapping either tile toggles the swap — but only while there's something
  // to swap with and no material/screen-share is dominating the stage
  // (resolveCallStage ignores `swapped` in that case, so a tap would be a
  // confusing no-op; the tiles simply aren't made tappable there).
  const canSwap = remoteCount > 0 && !activeMaterial && !screenShareActive;
  const toggleSwap = useCallback(() => {
    setSwapped((s) => !s);
  }, []);

  // --- Draggable self-view / remote-PiP tiles -----------------------------
  // Raw Pointer Events + setPointerCapture, same primitive the minimized
  // bubble already uses below (no drag/gesture library on web, matching
  // mobile's own no-Reanimated PanResponder choice) — pointer events cover
  // mouse and touch identically, so there's no separate touch path to keep
  // in sync.
  const beginTileDrag = useCallback(
    (tile: "local" | "remote", corner: "left" | "right") => (e: React.PointerEvent) => {
      if (minimized) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const bounds = tileBounds();
      const current =
        (tile === "local" ? localTilePos : remoteTilePos) ??
        initialFloatingTilePosition(bounds, corner);
      tileDragRef.current = {
        tile,
        startX: e.clientX,
        startY: e.clientY,
        originX: current.x,
        originY: current.y,
        startedAt: Date.now(),
      };
      setDraggingTile(tile);
    },
    [minimized, localTilePos, remoteTilePos, tileBounds],
  );
  const onTileDragMove = useCallback(
    (e: React.PointerEvent) => {
      const ds = tileDragRef.current;
      if (!ds) return;
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      const next = clampSelfViewPosition(
        { x: ds.originX, y: ds.originY },
        { dx, dy },
        tileBounds(),
      );
      if (ds.tile === "local") setLocalTilePos(next);
      else setRemoteTilePos(next);
    },
    [tileBounds],
  );
  // A tile release that barely moved and was quick is a TAP (toggleSwap),
  // matching the click-to-swap behavior this replaces — dragging and
  // tapping share the same pointer handlers so there's exactly one gesture
  // path per tile instead of a separate onClick fighting with the drag.
  const endTileDrag = useCallback(
    (onTap: () => void) => (e: React.PointerEvent) => {
      const ds = tileDragRef.current;
      tileDragRef.current = null;
      setDraggingTile(null);
      if (!ds) return;
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (isTapGesture({ dx, dy }, Date.now() - ds.startedAt)) {
        onTap();
      }
    },
    [],
  );
  // --- Minimize (floating draggable bubble) -------------------------------
  const floatingBounds = useCallback((): FloatingBounds => {
    return {
      width: typeof window === "undefined" ? 400 : window.innerWidth,
      height: typeof window === "undefined" ? 800 : window.innerHeight,
      tileWidth: FLOATING_CALL_WIDTH,
      tileHeight: FLOATING_CALL_HEIGHT,
      margin: FLOATING_CALL_MARGIN,
    };
  }, []);
  const defaultFloatingPos = useCallback(
    () => floatingCornerPosition("bottom-right", floatingBounds()),
    [floatingBounds],
  );
  // Only offered while nothing else owns the stage — minimizing mid-material
  // or mid-screen-share would need a decision about what the bubble even
  // shows (see the component's top note); scoping it out here keeps the
  // bubble to a single, always-legible primary tile.
  const canMinimize = !activeMaterial && !screenShareActive;

  // Go-to-chat (WhatsApp parity): jump to the message thread with the other
  // party WITHOUT hanging up. Minimizing first (rather than leaving the call
  // running full-screen underneath a route change) is what makes this safe —
  // the call keeps connecting/publishing exactly as it did before this
  // existed, just as a small bubble instead of the full-screen overlay, and
  // CallSessionOverlay (app root) is what keeps it mounted through the
  // navigation at all. Unconditional (unlike the explicit Minimize button,
  // which respects `canMinimize` to avoid abandoning a material/share
  // mid-view) — this was previously gated on `canMinimize` too, which meant
  // clicking Message while viewing a material or screen share navigated the
  // URL but left the full-screen call sitting on top of it, so the chat
  // never became visible. Going to chat always minimizes; the material/
  // share state itself isn't cleared, so expanding back shows it again.
  const goToChat = useCallback(() => {
    if (!chatHref) return;
    posthog?.capture("call_chat_opened", analyticsProps());
    setMinimized(true);
    router.push(chatHref);
  }, [chatHref, router, posthog, analyticsProps]);

  // Re-snap to the nearest corner of the new viewport on resize/rotation, so
  // a bubble left in a corner never ends up stranded off-screen or under a
  // notch after the window changes size.
  useEffect(() => {
    if (!minimized) return;
    const onResize = () => {
      setFloatingPos((p) => {
        if (!p) return p;
        const snapped = snapToNearestCorner(p, floatingBounds());
        return { x: snapped.x, y: snapped.y };
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [minimized, floatingBounds]);

  const onBubblePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!minimized) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const pos = floatingPos ?? defaultFloatingPos();
      dragStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: pos.x,
        originY: pos.y,
        moved: false,
      };
      setDragging(true);
    },
    [minimized, floatingPos, defaultFloatingPos],
  );
  const onBubblePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (Math.hypot(dx, dy) > 4) ds.moved = true;
    setFloatingPos({ x: ds.originX + dx, y: ds.originY + dy });
  }, []);
  const onBubblePointerUp = useCallback(() => {
    const ds = dragStateRef.current;
    if (!ds) return;
    dragStateRef.current = null;
    setDragging(false);
    if (!ds.moved) {
      // A tap, not a drag: expand back to full screen with one tap.
      setMinimized(false);
      return;
    }
    setFloatingPos((p) => {
      const snapped = snapToNearestCorner(p ?? defaultFloatingPos(), floatingBounds());
      return { x: snapped.x, y: snapped.y };
    });
  }, [defaultFloatingPos, floatingBounds]);

  // Opens a real OS-level floating window (not the in-page bubble above) that
  // keeps showing the call even if the user switches browser tabs or
  // minimizes the browser entirely — the one thing the in-page bubble can't
  // do. Minimizes the in-page UI at the same time so the two don't compete
  // for attention; closing the PiP window (its own native close button, or
  // requestClose here) just leaves the in-page bubble already there to tap.
  const openPip = useCallback(async () => {
    if (pipActive) return;
    const docPip = getDocumentPictureInPicture();
    if (!docPip) return;
    try {
      const pipWindow = await docPip.requestWindow({
        width: FLOATING_CALL_WIDTH * 2,
        height: FLOATING_CALL_HEIGHT * 2,
      });
      pipWindowRef.current = pipWindow;
      pipWindow.document.title = t("call.title");
      pipWindow.document.body.style.margin = "0";
      pipWindow.document.body.style.background = "#000";
      pipWindow.addEventListener(
        "pagehide",
        () => {
          pipWindowRef.current = null;
          setPipActive(false);
        },
        { once: true },
      );
      setMinimized(true);
      setPipActive(true);
    } catch {
      // Blocked (no user-activation on this tap, disabled by browser policy,
      // or the user cancelled) — stay with the in-page bubble, no error UI:
      // this is a progressive enhancement, not a control the user explicitly
      // asked to see fail.
    }
  }, [pipActive, t]);

  const closePip = useCallback(() => {
    pipWindowRef.current?.close();
  }, []);

  // No moderation asymmetry here (unlike Record/Captions, which are
  // teacher-gated) — either party can share their screen, so this toggle is
  // always shown. The actual on/off state is reconciled from
  // LocalTrackPublished/LocalTrackUnpublished above (including the browser's
  // own "stop sharing" affordance), not set optimistically here, mirroring
  // how `recording` is server-driven rather than assumed.
  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setScreenShareEnabled(!screenShareOn, { audio: false });
      // setScreenShareEnabled resolving is not itself proof of success on
      // every browser path (e.g. the user cancelling the native picker can
      // resolve rather than reject in some cases) — LocalTrackPublished /
      // LocalTrackUnpublished above are the actual source of truth for
      // screenShareOn, so no optimistic setScreenShareOn(...) here.
    } catch {
      /* permission denied, picker cancelled, or unavailable — leave as-is */
    }
  }, [screenShareOn]);

  const retry = useCallback(() => {
    setStatus("connecting");
    setReconnecting(false);
    setRetryKey((k) => k + 1);
  }, []);

  // Teacher toggles recording; the actual `recording` flag flips when LiveKit
  // emits RecordingStatusChanged to everyone, not optimistically.
  const toggleRecording = useCallback(async () => {
    if (!bookingId || recordPending) return;
    setRecordPending(true);
    setRecordError(null);
    const action = recording ? "stop" : "start";
    try {
      const res = recording
        ? await stopCallRecording(bookingId)
        : await startCallRecording(bookingId);
      posthog?.capture(
        "call_recording_toggled",
        analyticsProps({ action, outcome: res.ok ? "success" : "failed" }),
      );
      if (!res.ok) {
        setRecordError(t("call.recordError"));
      }
    } catch {
      posthog?.capture("call_recording_toggled", analyticsProps({ action, outcome: "failed" }));
      setRecordError(t("call.recordError"));
    } finally {
      setRecordPending(false);
    }
  }, [bookingId, recording, recordPending, t, posthog, analyticsProps]);

  // Ordinary classes are captioned server-side by the LiveKit Agent
  // (packages/livekit-captions-agent) — this toggle no longer starts a
  // client-side publish, it sets a participant attribute the Agent reads to
  // decide whether to forward audio to Deepgram/Anthropic at all (a
  // deliberate choice to preserve today's exact processing scope — audio is
  // only sent externally while this toggle is on, same as before). Only
  // rendered for the teacher (see canCaption's doc comment) — D-27's
  // original "teacher-toggled" design, restored after a since-undocumented
  // scope change briefly gave the student her own independent toggle. This
  // ONE switch now gates BOTH directions on the Agent side; her own
  // speech still separately requires her consent (captionsConsentMissing).
  const toggleCaptions = useCallback(() => {
    setCaptionsOn((on) => {
      const next = !on;
      void roomRef.current?.localParticipant.setAttributes({ captionsOn: next ? "true" : "false" });
      if (next) {
        captionsStartedAtRef.current = Date.now();
        // Turning the room's captions on must also bring the band back on
        // HER screen if she had hidden it earlier (the two are separate
        // switches by design — see the student's control in the row below).
        // Without this, a teacher who hid the band last lesson turns
        // subtitles on this lesson and sees nothing happen.
        setCaptionPrefs({ visible: true });
        posthog?.capture("call_captions_enabled", analyticsProps());
        const seen =
          typeof window !== "undefined" &&
          parseCaptionsNoticeSeen(
            window.localStorage.getItem(CAPTIONS_NOTICE_STORAGE_KEY),
            window.localStorage.getItem(LEGACY_CAPTIONS_NOTICE_STORAGE_KEY),
          );
        if (seen) {
          toast.success(t("call.captionsEnabledToast"));
        } else {
          setShowCaptionsNotice(true);
        }
      } else {
        const enabledDurationSeconds = captionsStartedAtRef.current
          ? Math.round((Date.now() - captionsStartedAtRef.current) / 1000)
          : undefined;
        captionsStartedAtRef.current = null;
        posthog?.capture("call_captions_disabled", analyticsProps({ enabledDurationSeconds }));
        setShowCaptionsNotice(false);
      }
      return next;
    });
  }, [t, posthog, analyticsProps, setCaptionPrefs]);

  const dismissCaptionsNotice = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(CAPTIONS_NOTICE_STORAGE_KEY, "1");
      // Drop the pre-D-138 key so a browser that carried it converges on the
      // new one instead of holding both forever.
      window.localStorage.removeItem(LEGACY_CAPTIONS_NOTICE_STORAGE_KEY);
    }
    setShowCaptionsNotice(false);
  }, []);

  // One-tap bookmark (D-97) — not a toggle: each press adds another marker.
  // `bookmarked` flashes briefly as the only feedback (there's nothing to
  // undo/reflect, unlike Record).
  const addBookmark = useCallback(async () => {
    if (!onBookmark || bookmarkPending) return;
    setBookmarkPending(true);
    setBookmarkError(null);
    try {
      const res = await onBookmark();
      if (res.ok) {
        setBookmarked(true);
        setTimeout(() => setBookmarked(false), 1500);
      } else {
        setBookmarkError(t("call.bookmarkError"));
      }
    } catch {
      setBookmarkError(t("call.bookmarkError"));
    } finally {
      setBookmarkPending(false);
    }
  }, [onBookmark, bookmarkPending, t]);

  // Keyboard shortcuts. Every serious call surface has these and this one had
  // none, which costs a teacher the single most time-critical action in a
  // lesson: muting to cough, or unmuting to answer, without hunting for a
  // 48px circle with the mouse.
  //
  // Deliberately UNMODIFIED single keys, matching Meet and Zoom's own `m`/`v`
  // — a modifier chord is what you use when a page has text input to protect,
  // and the guard below is the better answer to that. `c` is subtitles, which
  // does the role-appropriate thing: the teacher's key flips the room switch,
  // the student's flips her own band.
  useEffect(() => {
    if (minimized) return;
    const onKey = (e: KeyboardEvent) => {
      // Never steal a keystroke from a field. The materials browser has a
      // search input, and a teacher typing "movie" into it must not mute
      // herself twice and turn her camera off.
      const el = e.target as HTMLElement | null;
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        (el &&
          (el.isContentEditable ||
            el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.tagName === "SELECT"))
      ) {
        return;
      }
      switch (e.key.toLowerCase()) {
        case "m":
          e.preventDefault();
          void toggleMic();
          return;
        case "v":
          e.preventDefault();
          void toggleCam();
          return;
        case "c":
          e.preventDefault();
          if (canCaption) toggleCaptions();
          // The student cannot turn the room's captions on, so for her the
          // same key does the thing she CAN do: show or hide the band on her
          // own screen — and only while there are captions to hide.
          else if (roomCaptionsOn) setCaptionPrefs({ visible: !captionPrefs.visible });
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    minimized,
    toggleMic,
    toggleCam,
    toggleCaptions,
    canCaption,
    roomCaptionsOn,
    captionPrefs.visible,
    setCaptionPrefs,
  ]);

  // Connected but neither camera nor mic is on — the "I just see a blank screen"
  // case. Almost always a mobile browser that wouldn't auto-start media; the fix
  // is to tap a control, so say exactly that.
  const mediaOff = status === "connected" && !micOn && !camOn;
  // Connected and alone — explain the black screen instead of leaving a void.
  const waitingForOther = status === "connected" && remoteCount === 0;

  // When a material — or now a screen share — fills the stage it replaces the
  // OTHER participant's camera video. Rather than hiding them entirely, shrink
  // their video into a small corner tile (like the self-view) so each side can
  // still glance at the other while looking at the content. Shared with
  // mobile so the two can't drift; screen share reuses the same
  // materialOpen-driven layout since it dominates the stage identically.
  const stage = resolveCallStage({
    materialOpen: Boolean(activeMaterial) || screenShareActive,
    hasRemote: remoteCount > 0,
    swapped,
  });
  const remoteIsBig = stage.main === "remote";
  const localIsBig = stage.main === "local";
  // Minimized mode shows exactly one tile (the current primary) and nothing
  // else — see canMinimize above for why material/screen-share are excluded
  // from ever reaching this state in the first place.
  const remoteRole: StageTileRole = minimized
    ? remoteIsBig
      ? "big"
      : "hidden"
    : resolveTileRole({
        isBig: remoteIsBig,
        isFloating: stage.remotePip,
        corner: stage.main === "material" ? "left" : "right",
      });
  const localRole: StageTileRole = minimized
    ? localIsBig
      ? "big"
      : "hidden"
    : resolveTileRole({ isBig: localIsBig, isFloating: !localIsBig && camOn, corner: "right" });
  const floatingPosResolved = floatingPos ?? defaultFloatingPos();

  // Is a floating camera tile sitting in its default bottom corner? The band
  // uses this to keep clear of it.
  //
  // It used to answer a different question — how far UP the band should move —
  // and that was wrong in the way that matters. The tile is 110×150 in the
  // bottom-RIGHT corner, and dodging it vertically cost 166px of height across
  // the FULL width of the stage. On a phone that is about a third of the
  // visible video, and it put the subtitles in the middle of the screen: the
  // one place subtitles must never be, and the most expensive place to put
  // them. Reported from a real call on both a laptop and an Android phone.
  //
  // The clearance is horizontal now (see CaptionBand), because the obstruction
  // is horizontal. Subtitles keep the bottom edge, which is where every video
  // player puts them and where they cost the least.
  //
  // Only while a tile is actually PARKED: once the user drags one it can be
  // anywhere, and reserving a column for a tile that has moved would narrow
  // the subtitles for nothing. A tile dragged back over them is the user's own
  // arrangement, and both are movable.
  const tileParkedAtBottom =
    (isFloatingRole(localRole) && !localTilePos) || (isFloatingRole(remoteRole) && !remoteTilePos);

  // A tile stops being floating (swapped to the main stage, or hidden) —
  // drop its remembered drag position so the next time it floats again it
  // starts back at the default corner rather than resuming a position that
  // made sense in a different layout. Placed here (rather than beside the
  // other tile-drag hooks above) because it depends on localRole/remoteRole,
  // which resolveCallStage/resolveTileRole only compute this late in render.
  useEffect(() => {
    if (!isFloatingRole(localRole)) setLocalTilePos(null);
  }, [localRole]);
  useEffect(() => {
    if (!isFloatingRole(remoteRole)) setRemoteTilePos(null);
  }, [remoteRole]);

  // Render through a portal to <body>. The app shell wraps every page in an
  // `animate-fade-in-up` element whose `transform` (kept by `animation-fill-mode:
  // both`) makes it the containing block for any descendant `position: fixed`.
  // Inside it our `fixed inset-0` overlay was sized to that wrapper (≈0 height on
  // the call route) instead of the viewport, collapsing the video pane to nothing
  // and pushing the controls to the top. Portaling to <body> escapes the
  // transformed ancestor so the overlay is truly viewport-sized.
  if (typeof document === "undefined") return null;

  return (
    <>
      {createPortal(
        <div
          className={cn(
            "fixed z-50 flex flex-col bg-black text-white",
            minimized ? "overflow-hidden rounded-2xl shadow-2xl" : "inset-0",
          )}
          style={
            minimized
              ? {
                  left: floatingPosResolved.x,
                  top: floatingPosResolved.y,
                  width: FLOATING_CALL_WIDTH,
                  height: FLOATING_CALL_HEIGHT,
                  transition: dragging ? undefined : "left 220ms ease, top 220ms ease",
                  touchAction: "none",
                }
              : undefined
          }
          onPointerDown={onBubblePointerDown}
          onPointerMove={onBubblePointerMove}
          onPointerUp={onBubblePointerUp}
          onPointerCancel={onBubblePointerUp}
          role={minimized ? "button" : undefined}
          aria-label={minimized ? t("call.expand") : undefined}
        >
          {/* Drag handle — a purely visual affordance (the whole bubble is
          already draggable via the pointer handlers above; this just signals
          it), so a user unfamiliar with the mini player recognizes it as
          draggable rather than a static badge. */}
          {minimized && (
            <div
              aria-hidden
              className="bg-overlay-3 pointer-events-none absolute top-1.5 left-1/2 z-30 h-1 w-7 -translate-x-1/2 rounded-full"
            />
          )}

          {/* Remote participant fills the screen by default; local is a small
          self-view. Tapping either tile swaps which one is "big" — see
          resolveTileRole above, which turns the stage + swap state into one
          of four roles per tile. Both tiles stay mounted at all times so a
          swap (or a minimize) is purely a CSS position/size change: no
          track ever gets detached or re-attached to move it. */}
          <div className="relative flex-1 overflow-hidden">
            <div
              ref={remoteRef}
              style={computeStageTileStyle(remoteRole, {
                position: remoteTilePos,
                dragging: draggingTile === "remote",
              })}
              // ph-no-capture: belt-and-braces against PostHog session replay
              // ever serializing the live call feed (docs/architecture/
              // the call-analytics review) — this container holds the
              // real remote <video>/<audio> elements attached in the connect
              // effect above.
              className={cn(
                "ph-no-capture overflow-hidden bg-black",
                // Full-screen "big" tile: show the whole frame, letterboxed if the
                // camera's aspect ratio doesn't match the viewport — object-cover
                // there was cropping in tight (reported as "zoomed in") whenever a
                // participant's stream wasn't the same ratio as the window. The
                // small floating/PiP corner tile stays object-cover on purpose: a
                // tight thumbnail crop is the intended look for that bubble, same
                // as the self-view below.
                remoteRole === "big" ? "[&>video]:object-contain" : "[&>video]:object-cover",
                remoteRole !== "big" &&
                  remoteRole !== "hidden" &&
                  "border-overlay-1 rounded-lg border shadow-lg",
              )}
              // Dragging and tap-to-swap share one pointer-event path: a
              // release that barely moved swaps (matching the previous
              // onClick), a release that moved is a drag, freely
              // repositioning the tile within the viewport (item 1 of the
              // web/mobile call-UX parity work — mirrors mobile's
              // DraggableVideoTile). Only floating tiles are draggable; the
              // full-screen "big" tile has nowhere to drag to.
              onPointerDown={(e) => {
                if (minimized || !isFloatingRole(remoteRole)) return;
                beginTileDrag("remote", stage.main === "material" ? "left" : "right")(e);
              }}
              onPointerMove={onTileDragMove}
              onPointerUp={endTileDrag(() => {
                if (!minimized && stage.main === "local" && canSwap) toggleSwap();
              })}
              onPointerCancel={endTileDrag(() => {})}
              onKeyDown={
                !minimized && stage.main === "local" && canSwap
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleSwap();
                      }
                    }
                  : undefined
              }
              role={!minimized && stage.main === "local" && canSwap ? "button" : undefined}
              tabIndex={!minimized && stage.main === "local" && canSwap ? 0 : undefined}
              aria-label={
                !minimized && stage.main === "local" && canSwap ? t("call.swapToPip") : undefined
              }
            />

            {/* Material viewer replaces the remote video (fills the stage under the
            chrome below, which is bumped to z-20 so it stays visible over it). */}
            {activeMaterial && !minimized && (
              <CallMaterialViewer
                material={activeMaterial}
                onClose={() => setActiveMaterial(null)}
              />
            )}

            {/* Screen share (local or remote) dominates the stage exactly like a
            material does — camera views shrink to corner tiles via
            `stage.remotePip` above. Always mounted (never conditionally
            rendered on `screenShareActive`) so the ref exists the instant a
            TrackSubscribed/LocalTrackPublished handler needs to attach into
            it; `hidden` only toggles visibility, matching the self-view
            video's own pattern below. bg-black avoids a flash of the remote
            camera behind it while the share track's first frame is still
            landing. */}
            <div
              ref={screenShareRef}
              className={cn(
                "ph-no-capture absolute inset-0 z-10 bg-black",
                screenShareActive && !minimized ? "" : "hidden",
              )}
            />

            {/* THE STATUS STACK — one column, top-centre, that owns every
            transient message on the stage.

            These were six independent absolutely-positioned banners at
            `top-4` and `top-16`, and they collided: recording and
            screen-sharing both sat at top-4 (a recorded lesson with a shared
            worksheet drew one exactly on top of the other), while
            reconnecting, the flip-camera error and the captions-consent hint
            all shared top-16. Each was correct alone and the set was not,
            because nothing owned the arrangement. A stack does: whatever is
            true is shown, in a fixed order of urgency, and two true things
            are two rows rather than one overdraw.

            Ordered most-actionable first — a message the user must act on
            (allow the camera, give consent) sits above one that is purely
            informational (something is being recorded). Note pointer-events
            stay off the column so it never blocks the video beneath it; no
            row here is interactive. */}
            {!minimized && (
              <div className="pointer-events-none absolute inset-x-4 top-4 z-20 flex flex-col items-center gap-2">
                {/* Connected but neither camera nor mic is on — the "I just
                see a blank screen" case. Almost always a mobile browser that
                would not auto-start media; the fix is to tap a control. */}
                {mediaOff && <StatusPill tone="attention" label={t("web.classCall.mediaOff")} />}
                {/* Captions are available room-wide but THIS student has not
                consented, so her own speech is not transcribed (the captions
                architecture review P0) — say so rather than silently doing
                nothing. Only worth saying while captions are actually on. */}
                {captionsConsentMissing && roomCaptionsOn && (
                  <StatusPill tone="attention" label={t("call.captionsConsentHint")} />
                )}
                {/* Camera-switch failure — brief, non-blocking (the camera
                keeps working on whichever device it already had). */}
                {flipCameraError && (
                  <StatusPill tone="attention" label={t("call.flipCameraError")} />
                )}
                {/* A transient drop, not a fatal error. */}
                {reconnecting && status === "connected" && (
                  <StatusPill tone="warning" pulse label={t("web.classCall.reconnecting")} />
                )}
                {/* Shown to BOTH parties whenever the room is being recorded
                (driven by LiveKit's own state), so nobody is recorded
                silently. */}
                {recording && <StatusPill tone="recording" pulse label={t("call.recording")} />}
                {/* Which side is sharing, for the party on the receiving end
                (the sharer's own button already reads as active). */}
                {screenShareActive && (
                  <StatusPill tone="info" pulse label={t("call.screenSharing")} />
                )}
                {/* Subtitles are on but the reader has hidden the band on her
                own screen. Without this the Subtitles control looks off and
                the feature looks broken; with it, the way back is one tap. */}
                {roomCaptionsOn && !captionPrefs.visible && (
                  <StatusPill tone="info" label={t("call.captionsHiddenHint")} />
                )}
              </div>
            )}

            {status === "connecting" && !minimized && (
              <div className="text-on-dark-muted absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center text-lg">
                {t("call.connecting")}
                {/* Appears only once the join is visibly stalled, so an ordinary
                fast connect never flashes buttons mid-join. Before this the
                connecting state had no affordances at all — a connect that
                never settled left no way out but the browser's back button. */}
                {connectingStalled && (
                  <div className="flex gap-3 text-base">
                    <button
                      onClick={retry}
                      className="bg-overlay-1 hover:bg-overlay-2 rounded-lg px-5 py-3 font-medium text-white"
                    >
                      {t("call.retry")}
                    </button>
                    <button
                      onClick={leave}
                      className="bg-overlay-1 hover:bg-overlay-2 rounded-lg px-5 py-3 font-medium text-white"
                    >
                      {t("call.leave")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {waitingForOther && !activeMaterial && !minimized && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
                <p className="text-on-dark-faint text-lg">{t("call.waiting")}</p>
                {onNudge && (
                  <>
                    <p className="text-on-dark-faint max-w-xs text-sm">{t("call.nudgeHint")}</p>
                    <button
                      onClick={nudge}
                      disabled={
                        nudgeState === "sending" ||
                        nudgeState === "sent" ||
                        nudgeState === "cooldown"
                      }
                      className="bg-overlay-1 hover:bg-overlay-2 rounded-lg px-5 py-3 text-base font-medium disabled:opacity-60"
                    >
                      {nudgeState === "idle"
                        ? t("call.nudge")
                        : nudgeState === "sending"
                          ? t("call.nudgeSending")
                          : nudgeState === "sent"
                            ? t("call.nudgeSent")
                            : nudgeState === "cooldown"
                              ? t("call.nudgeCooldown")
                              : t("call.nudgeError")}
                    </button>
                  </>
                )}
              </div>
            )}

            {status === "error" && !minimized && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black px-8 text-center">
                <p className="text-on-dark-muted text-lg">{t("call.connectError")}</p>
                <div className="flex gap-3">
                  <button
                    onClick={retry}
                    className="bg-overlay-1 hover:bg-overlay-2 rounded-lg px-5 py-3 font-medium"
                  >
                    {t("call.retry")}
                  </button>
                  <button
                    onClick={leave}
                    className="bg-overlay-1 hover:bg-overlay-2 rounded-lg px-5 py-3 font-medium"
                  >
                    {t("call.leave")}
                  </button>
                </div>
              </div>
            )}

            {/* Self-view, only while the camera is on (an empty box otherwise). Opaque
            bg-black behind it: a <video> with no decoded frame (a momentary gap
            between the track being (re)attached and it producing frames) is
            transparent, not black, so without a backing color it reveals the
            remote video underneath — reading as the self-view having "gone
            transparent" the moment a second participant's video fills the
            screen behind it. Tapping it while it's the small floating tile
            swaps it to the main stage (see remoteRef's onClick above for the
            reverse direction); while it IS the main stage this is a plain,
            non-interactive video. */}
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              style={computeStageTileStyle(localRole, {
                position: localTilePos,
                dragging: draggingTile === "local",
              })}
              className={cn(
                "ph-no-capture bg-black",
                // Same reasoning as remoteRef's className above: contain when this
                // tile is swapped to fill the screen, cover for the small bubble.
                localRole === "big" ? "object-contain" : "object-cover",
                localRole === "hidden" && "invisible",
                localRole !== "big" &&
                  localRole !== "hidden" &&
                  "border-overlay-1 rounded-lg border shadow-lg",
              )}
              // See remoteRef's pointer handlers above — same drag/tap-to-swap
              // path, mirrored for this tile.
              onPointerDown={(e) => {
                if (minimized || localRole !== "floating-right") return;
                beginTileDrag("local", "right")(e);
              }}
              onPointerMove={onTileDragMove}
              onPointerUp={endTileDrag(() => {
                if (!minimized && localRole === "floating-right" && canSwap) toggleSwap();
              })}
              onPointerCancel={endTileDrag(() => {})}
              onKeyDown={
                !minimized && localRole === "floating-right" && canSwap
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleSwap();
                      }
                    }
                  : undefined
              }
              role={!minimized && localRole === "floating-right" && canSwap ? "button" : undefined}
              tabIndex={!minimized && localRole === "floating-right" && canSwap ? 0 : undefined}
              aria-label={
                !minimized && localRole === "floating-right" && canSwap
                  ? t("call.swapToMain")
                  : undefined
              }
            />

            {/* Live subtitles, anchored to the bottom of the stage the way
            every video player anchors them. `tileParked` lets the band keep
            clear of a parked camera tile sideways rather than by climbing the
            screen — see the note on tileParkedAtBottom above, and
            caption-band.tsx for the rest.
            Suppressed while a material or screen share
            owns the stage: the subtitles would sit over the worksheet the
            teacher just put up, and that content is the thing being looked
            at. The transcript stays reachable throughout, which is where the
            lines go instead of being lost. */}
            {!minimized && !activeMaterial && !screenShareActive && (
              <CaptionBand
                entries={captions.visible}
                prefs={captionPrefs}
                onPrefsChange={setCaptionPrefs}
                speakerName={speakerName}
                tileParked={tileParkedAtBottom}
                // Only until the FIRST line of the call, not in every pause
                // between sentences: once subtitles have demonstrably worked,
                // a "Listening…" pill blinking in and out of every gap in the
                // conversation is fidget, not reassurance.
                awaitingFirstLine={roomCaptionsOn && captions.transcript.length === 0}
                hasTranscript={captions.transcript.length > 0}
                onOpenTranscript={() => setTranscriptOpen(true)}
              />
            )}

            {transcriptOpen && !minimized && (
              <CaptionTranscript
                entries={captions.transcript}
                speakerName={speakerName}
                onClose={() => setTranscriptOpen(false)}
              />
            )}

            {/* Disclosure (D-22-style: a visible notice AND a structural consent
            gate, not either alone) — shown ONCE per browser, the first time
            this side ever turns captions on (see CAPTIONS_NOTICE_STORAGE_KEY). Every
            later enable is just a brief toast (fired from toggleCaptions)
            instead of re-showing this card over the video/materials/caption
            band. */}
            {showCaptionsNotice && !minimized && (
              // Centred on the stage rather than pinned at `bottom-24`, which
              // was chosen when the caption band lived at a fixed `bottom-4`
              // and is now exactly where the band sits. It is also the
              // stronger placement for what this is: a one-time consent
              // disclosure that should be READ, not a hint tucked into the
              // chrome. `role="status"` announces it without stealing focus,
              // since the call itself keeps running behind it.
              <div
                role="status"
                className="w-dialog-inset bg-scrim-3 absolute top-1/2 left-1/2 z-30 flex max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 rounded-2xl px-5 py-4 text-center shadow-lg backdrop-blur-xs"
              >
                <p className="text-base font-semibold text-white">
                  {t("call.captionsNoticeTitle")}
                </p>
                <p className="text-on-dark-muted text-sm leading-snug">
                  {t("call.captionsDisclosure")}
                </p>
                <button
                  type="button"
                  onClick={dismissCaptionsNotice}
                  className="min-h-target bg-overlay-4 text-scrim-3 hover:bg-overlay-3 mt-1 rounded-full px-5 text-sm font-semibold"
                >
                  {t("call.captionsNoticeDismiss")}
                </button>
              </div>
            )}

            {/* The live-notes panel, overlaid. This wrapper is position/size ONLY —
            the visible card (background, padding, shadow) lives inside the
            overlay component itself so that when it has nothing to show it
            renders null and NOTHING here is visible. An always-present
            background box here was exactly the "empty translucent panel" bug:
            the student's InstructionsOverlay returns null with no notes, yet
            this box stayed painted, reserving space over the video. Mobile
            already solved this by only passing an overlay when it has content
            (see NativeCall's overlay note); web collapses the same way now.
            An empty wrapper is 0-height and paints nothing, so it neither shows
            nor blocks the video underneath. */}
            {overlay && !minimized && (
              <div className="max-h-over-stage absolute top-4 left-4 z-20 w-72 overflow-y-auto">
                {overlay}
              </div>
            )}

            {/* Minimize control, top-right — the one control kept reachable
            without wrapping the main row, matching where Meet/Zoom/FaceTime
            all place it. Hidden while a material/screen-share owns the stage
            (see canMinimize) since the bubble can only ever show one plain
            video tile.

            ALSO HIDDEN WHILE THE TRANSCRIPT IS OPEN, and that condition is
            load-bearing rather than tidy. The transcript panel is a sibling
            of this button at `top-0 right-0 z-30`, and this button sits at
            `top-4 right-4 z-30`: same stacking context, same z-index, and
            this button is LATER in the DOM, so it paints on top. Where it
            lands is exactly the transcript's own close button, which sits in
            that panel's header at the same inset. The reader taps the × she
            can see, minimises the entire call instead, and — on a phone,
            where there is no Escape key to fall back on — has no way left to
            put the transcript away. Raising the panel's z-index would fix the
            paint order and leave two circles stacked on one another, so the
            control that cannot be used while a panel owns the right edge is
            simply not rendered. Same reasoning as canMinimize above: the
            button is suppressed by whatever owns the stage. */}
            {!minimized && canMinimize && !transcriptOpen && (
              <button
                type="button"
                onClick={() => setMinimized(true)}
                aria-label={t("call.minimize")}
                title={t("call.minimize")}
                className="bg-overlay-1 hover:bg-overlay-2 absolute top-4 right-4 z-30 flex h-9 w-9 items-center justify-center rounded-full text-white backdrop-blur-md"
              >
                <Minimize2 className="h-4 w-4" aria-hidden />
              </button>
            )}

            {/* Pop-out (Document Picture-in-Picture) — a real OS-level floating
            window, distinct from the in-page bubble above it. Feature-detected
            (pipSupported), so this simply doesn't render on browsers without
            it (Safari, Firefox as of this writing) rather than showing a
            button that would always fail.

            Suppressed with the transcript for the same reason as the button
            above — at `right-16 top-4` it lands inside that panel's header
            row, over the title. It is also why the collision reads as two
            floating icons on top of each other on a browser that supports
            PiP, and as one stuck × on a browser that does not. */}
            {!minimized && canMinimize && pipSupported && !transcriptOpen && (
              <button
                type="button"
                onClick={() => {
                  void openPip();
                }}
                aria-label={t("call.popOut")}
                title={t("call.popOut")}
                className="bg-overlay-1 hover:bg-overlay-2 absolute top-4 right-16 z-30 flex h-9 w-9 items-center justify-center rounded-full text-white backdrop-blur-md"
              >
                <PictureInPicture2 className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>

          {minimized ? (
            // The minimized bubble keeps exactly one control reachable without
            // expanding: hang up. Its own pointerdown must not start a drag (the
            // outer div's onPointerDown is what drags the bubble), and its click
            // must not also count as the "tap to expand" release on the outer
            // div — stopPropagation on both covers that.
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                leave();
              }}
              aria-label={t("call.leave")}
              title={t("call.leave")}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 absolute top-1.5 right-1.5 z-30 flex h-7 w-7 items-center justify-center rounded-full"
            >
              <PhoneOff className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : (
            // controlsRef is what `controlsHeight` measures. It was declared
            // and read (the tile-drag clamp's `controlsBlockH`, and now the
            // caption band's bottom inset) but never ATTACHED to anything, so
            // the height was permanently 0: a self-view tile could be dragged
            // down behind the control row and become unreachable, which is
            // precisely the bound clampSelfViewPosition exists to enforce.
            <div ref={controlsRef}>
              {/* Record/Stop error, surfaced so a rejected toggle isn't a silent no-op. */}
              {recordError && (
                <p className="text-destructive px-3 pb-1 text-center text-sm">{recordError}</p>
              )}
              {bookmarkError && (
                <p className="text-destructive px-3 pb-1 text-center text-sm">{bookmarkError}</p>
              )}

              {/* Controls: a floating row of glass icon buttons (redesign item 3 —
              no permanent background panel behind them; each button carries its
              own translucent/blurred backing, see CallButton below), with a
              short caption beneath each one, so the whole cluster fits one row
              and wraps only on the narrowest screens instead of a row of wide
              pills. Never hides itself (no auto-hide, no inactivity fade — see
              git history for the previous tap-to-reveal behavior); the only
              thing that moves it is the drawer handle CallControlsDrawer draws
              directly above it, and only when a teacher or student taps that.
              Web parity with mobile's `controlsCollapsed` in NativeCall.tsx. */}
              <CallControlsDrawer>
                <div className="flex flex-wrap items-start justify-center gap-x-2 gap-y-3 px-3 py-4 lg:gap-x-3">
                  <CallButton
                    onClick={toggleMic}
                    active={micOn}
                    icon={micOn ? Mic : MicOff}
                    label={micOn ? t("call.mute") : t("call.unmute")}
                    shortcut="m"
                  />
                  <CallButton
                    onClick={toggleCam}
                    active={camOn}
                    icon={camOn ? Video : VideoOff}
                    label={camOn ? t("call.cameraOff") : t("call.cameraOn")}
                    shortcut="v"
                  />
                  {videoInputCount > 1 && (
                    <CallButton
                      onClick={() => {
                        void flipCamera();
                      }}
                      disabled={!camOn || flippingCamera}
                      icon={SwitchCamera}
                      label={t("call.flipCamera")}
                    />
                  )}
                  {chatHref && (
                    <CallButton onClick={goToChat} icon={MessageCircle} label={t("call.message")} />
                  )}
                  <CallButton
                    onClick={toggleScreenShare}
                    // Disabled while the OTHER side is already sharing — this is a 1:1
                    // call and two simultaneous shares would just have one clobber the
                    // other's stage. Never disabled for the sharer themselves so they
                    // can always stop their own share.
                    disabled={remoteScreenShareOn && !screenShareOn}
                    active={screenShareOn}
                    icon={screenShareOn ? MonitorX : MonitorUp}
                    label={screenShareOn ? t("call.screenShareOff") : t("call.screenShareOn")}
                  />
                  {/* THE TEACHER'S control is the room's switch: it decides
                  whether anyone's speech is transcribed at all, which is a
                  privacy and cost decision and rightly hers alone (D-27). */}
                  {canCaption && bookingId && (
                    <CallButton
                      onClick={toggleCaptions}
                      active={captionsOn}
                      icon={Captions}
                      label={captionsOn ? t("call.captionsOff") : t("call.captionsOn")}
                      shortcut="c"
                    />
                  )}
                  {/* THE STUDENT'S control is a different thing wearing the
                  same icon, and the difference is the point. She cannot turn
                  the feature on — but she was also given no way to get the
                  subtitles off her own screen, resize them, or move them off
                  the teacher's face, which are decisions about her screen and
                  nobody else's. This shows only while captions are actually
                  running, so it is never a dead control. */}
                  {!canCaption && roomCaptionsOn && (
                    <CallButton
                      onClick={() => setCaptionPrefs({ visible: !captionPrefs.visible })}
                      active={captionPrefs.visible}
                      icon={Captions}
                      label={
                        captionPrefs.visible
                          ? t("call.captionsHideMine")
                          : t("call.captionsShowMine")
                      }
                      shortcut="c"
                    />
                  )}
                  {canRecord && bookingId && (
                    <CallButton
                      onClick={toggleRecording}
                      active={recording}
                      disabled={recordPending}
                      icon={recording ? Square : Circle}
                      label={recording ? t("call.stopRecording") : t("call.record")}
                    />
                  )}
                  {onBookmark && bookingId && (
                    <CallButton
                      onClick={addBookmark}
                      active={bookmarked}
                      disabled={bookmarkPending}
                      icon={Bookmark}
                      label={bookmarked ? t("call.bookmarked") : t("call.bookmark")}
                    />
                  )}
                  {/* Teacher-only. The student's in-call Materials button is
                    deliberately gone: during a call the teacher drives what
                    the student looks at (the open-for choice sheet), so a
                    second, independent way for the student to pull up
                    material mid-lesson worked against that. The student's own
                    Materials page outside the call is unaffected. */}
                  {role !== "student" && (
                    <CallMaterialsPanel
                      materials={materials}
                      onOpenInCall={setActiveMaterial}
                      canBrowseLibrary={canBrowseLibrary}
                      bookingId={bookingId}
                      hasRemote={remoteCount > 0}
                      onSendToRemote={sendMaterialToOther}
                    />
                  )}
                  <CallButton onClick={leave} danger icon={PhoneOff} label={t("call.leave")} />
                </div>
              </CallControlsDrawer>
            </div>
          )}
        </div>,
        document.body,
      )}
      {pipActive &&
        pipWindowRef.current &&
        room &&
        createPortal(
          <PipMirror
            room={room}
            primary={stage.main === "local" ? "local" : "remote"}
            t={t}
            onLeave={leave}
            onClose={closePip}
          />,
          pipWindowRef.current.document.body,
        )}
    </>
  );
}

// The Document Picture-in-Picture window's entire content — a SEPARATE React
// tree from the main call UI (portaled into pipWindow.document.body by the
// caller), with its own <video> element. It attaches to the SAME live
// LiveKit track the main window is already showing (track.attach() supports
// multiple simultaneous elements), so opening/closing this window never
// touches the main window's own video or re-subscribes anything. Audio is
// deliberately NOT handled here: the main window stays mounted (minimized,
// not removed) whenever this is open, so its existing hidden <audio> element
// keeps playing throughout.
function PipMirror({
  room,
  primary,
  t,
  onLeave,
  onClose,
}: {
  room: Room;
  primary: "local" | "remote";
  t: TFunction;
  onLeave: () => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasTrack, setHasTrack] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const getTrack = () =>
      primary === "local"
        ? room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack
        : [...room.remoteParticipants.values()][0]?.getTrackPublication(Track.Source.Camera)
            ?.videoTrack;

    const sync = () => {
      const track = getTrack();
      if (track) {
        track.attach(el);
        setHasTrack(true);
      } else {
        setHasTrack(false);
      }
    };
    sync();
    // Polled rather than event-driven, matching the reconcile effect in the
    // main component (see its own note): the room can swap/restart the
    // relevant publication without firing an event this small mirror
    // listens for, and attach() is a cheap no-op when already correct.
    const interval = setInterval(sync, 2000);
    return () => {
      clearInterval(interval);
      const track = getTrack();
      track?.detach(el);
    };
  }, [room, primary]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000" }}>
      <video
        ref={videoRef}
        autoPlay
        muted={primary === "local"}
        playsInline
        className="ph-no-capture"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: hasTrack ? "block" : "none",
        }}
      />
      {!hasTrack && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.6)",
            fontFamily: "sans-serif",
            fontSize: 15,
          }}
        >
          {t("call.pipWaiting")}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          bottom: 8,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("call.expand")}
          title={t("call.expand")}
          style={pipButtonStyle}
        >
          <Minimize2Glyph />
        </button>
        <button
          type="button"
          onClick={onLeave}
          aria-label={t("call.leave")}
          title={t("call.leave")}
          style={{ ...pipButtonStyle, background: paletteDark.danger }}
        >
          <PhoneOffGlyph />
        </button>
      </div>
    </div>
  );
}

const pipButtonStyle: React.CSSProperties = {
  height: 32,
  width: 32,
  borderRadius: 16,
  border: "none",
  background: "rgba(255,255,255,0.2)",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

// WHY THE STYLES BELOW ARE INLINE LITERALS RATHER THAN TOKENS. This subtree is
// portaled into the Picture-in-Picture window, a SEPARATE document that has
// none of the main document's stylesheets — so `hsl(var(--token))` resolves to
// nothing there and every colour has to be a literal value. Where a literal is
// unavoidable the VALUE still comes from the palette (see `paletteDark.danger`
// above) so it cannot drift from the brand; only the mechanism is different.
// The design-drift scanner counts these, correctly — they are a real exception,
// not a false positive, and the count is the reminder that the exception exists.

// Plain inline SVGs, not the lucide-react <Minimize2>/<PhoneOff> components:
// lucide's icons render fine as React elements, but this tree is portaled
// into a SEPARATE document (the PiP window) that has none of the main
// document's stylesheets — and lucide's default styling relies on inherited
// `currentColor`/sizing that's safest not to depend on cross-document. Two
// tiny inline SVGs sidestep that entirely.
function Minimize2Glyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path
        d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function PhoneOffGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path
        d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 17.92zM8.16 8.16 2 2m14.85 20.85L2 2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// One row of the status stack. Four tones, each already a semantic token, so
// "what kind of message is this" is stated once at the call site instead of
// being re-derived from a colour class every time a banner is added.
//
// `pulse` is for a state that is ONGOING rather than a one-off notice — a
// recording light, a live share. It is motion-safe: a dot that never stops
// blinking is exactly the thing a reduced-motion setting is asking about.
function StatusPill({
  tone,
  label,
  pulse,
}: {
  tone: "attention" | "warning" | "recording" | "info";
  label: string;
  pulse?: boolean;
}) {
  const toneClass = {
    // "attention" is the light-on-dark inversion — it is the loudest thing
    // available on a black stage, which is right for the messages that are
    // asking the user to DO something.
    attention: "bg-background text-foreground",
    warning: "bg-warning text-warning-foreground",
    recording: "bg-destructive text-destructive-foreground",
    info: "bg-info text-info-foreground",
  }[tone];
  return (
    <div
      // Announced once when it appears. Not aria-live="assertive": none of
      // these is urgent enough to cut across what the user is doing, and the
      // recording pill in particular is persistent, which assertive would
      // turn into a repeated interruption.
      role="status"
      className={cn(
        "flex max-w-md items-center gap-2 rounded-full px-3.5 py-1.5 text-center text-sm font-medium shadow-lg",
        toneClass,
      )}
    >
      {pulse && (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full bg-current motion-safe:animate-pulse"
        />
      )}
      {label}
    </div>
  );
}

// A round icon control button with a caption. `active` reads as "on" (a solid
// white tile with a dark icon); the idle state is a translucent tile with a
// white icon; `danger` (Leave) is the destructive red. The label is both the
// caption and the accessible name.
function CallButton({
  onClick,
  active,
  danger,
  disabled,
  icon: Icon,
  label,
  shortcut,
}: {
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  // The single-key shortcut this control also answers to, if any. Surfaced in
  // the tooltip and as `aria-keyshortcuts`, because a shortcut nobody is told
  // about is a shortcut nobody uses — and the visible caption under each icon
  // is already carrying the label, so the hint goes in the hover text rather
  // than crowding a 64px-wide control.
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut.toUpperCase()})` : label}
      aria-keyshortcuts={shortcut}
      aria-pressed={danger ? undefined : active}
      // No focus style of its own: globals.css's base-layer `:focus-visible`
      // rule already draws D-140's 3px ring, in the themed `--ring` indigo
      // that reads clearly against this black stage. An override here would
      // be re-implementing it slightly differently, which is the drift the
      // base-layer rule exists to prevent.
      className="flex w-16 flex-col items-center gap-1.5 rounded-lg disabled:opacity-50"
    >
      <span
        className={cn(
          "flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-colors",
          danger
            ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
            : active
              ? "bg-overlay-4 text-scrim-3 hover:bg-overlay-4"
              : "bg-overlay-1 hover:bg-overlay-2 text-white backdrop-blur-md",
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="text-on-dark-muted text-center text-sm leading-tight">{label}</span>
    </button>
  );
}
