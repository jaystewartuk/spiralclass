"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import {
  INTRO_VIDEO_IDEAL_MAX_SEC,
  INTRO_VIDEO_IDEAL_MIN_SEC,
  introVideoLengthVerdict,
} from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import {
  finalizeIntroVideoAction,
  presignIntroVideoUploadAction,
  removeIntroVideoAction,
  type ProfileState,
} from "@/app/actions/profile";
import { IntroVideoCoachPanel, type IntroVideoAnalysisPanelState } from "./intro-video-coach-panel";

// Cap the in-browser recording at 60s — the length we nudge teachers toward
// for an intro. A hard stop
// keeps the file small and the upload fast.
const MAX_RECORD_MS = 60_000;

// Preferred MediaRecorder mime types, best first. Chrome/Firefox give webm;
// Safari (18+) gives mp4. We fall back to the browser default if none match.
const PREFERRED_MIME = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_MIME.find((t) => MediaRecorder.isTypeSupported(t));
}

// Read a picked file's duration without uploading it, by letting a detached
// <video> parse just the metadata from an object URL. Resolves null on any
// failure (unsupported container, corrupt file, a browser reporting Infinity
// for a stream-ish MP4) — the duration is a nice-to-have for coaching, never a
// reason to block an upload. Always revokes the object URL.
export async function readVideoDurationMs(file: Blob): Promise<number | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const el = document.createElement("video");
      el.preload = "metadata";
      // Belt-and-braces: a file whose metadata never fires must not leave the
      // Save button spinning forever.
      const timer = setTimeout(() => resolve(null), 5000);
      const done = (value: number | null) => {
        clearTimeout(timer);
        resolve(value);
      };
      el.onloadedmetadata = () => {
        const seconds = el.duration;
        done(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
      };
      el.onerror = () => done(null);
      el.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function IntroVideoForm({
  videoUrl,
  analysis,
}: {
  videoUrl: string | null;
  analysis: IntroVideoAnalysisPanelState;
}) {
  const t = useT();
  const router = useRouter();
  const posthog = usePostHog();

  // Teacher-side funnel (D-73). The server only ever hears about attempts that
  // reached R2, so every step BEFORE that — opened the recorder, granted the
  // camera, finished a take, started the upload, failed the upload — has to be
  // captured here or it is simply unmeasurable. `surface: "web"` tags every
  // call with where it came from.
  const track = useCallback(
    (event: string, props: Record<string, unknown> = {}) => {
      posthog?.capture(event, { surface: "web", ...props });
    },
    [posthog],
  );

  // Upload is a client-driven presign → PUT-to-R2 → finalize flow, so it isn't
  // a Server-Action form: a gallery clip exceeds the
  // 25 MB action body limit. `uploadState`/`uploading` drive the status + spinner.
  const [uploadState, setUploadState] = useState<ProfileState>(undefined);
  const [uploading, setUploading] = useState(false);
  const [removeState, removeAction, removing] = useActionState<ProfileState, FormData>(
    removeIntroVideoAction,
    undefined,
  );

  // Recording state.
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recorded, setRecorded] = useState<{ blob: Blob; url: string; durationMs: number } | null>(
    null,
  );
  const [recorderError, setRecorderError] = useState<string | null>(null);
  // Upload is a SECONDARY path, collapsed behind a disclosure (D-73's review).
  // Recording in-app is what the product actually wants — a warm phone selfie
  // converts better than a produced marketing clip, and it's the only path with
  // a known duration, orientation and length cap. But upload is NOT removed:
  // a teacher whose browser blocks the camera would otherwise have no way at
  // all to add a video, and a teacher who already has a good clip shouldn't be
  // made to redo work. So: demoted, not deleted — and force-revealed below the
  // moment the recorder actually fails.
  const [showUpload, setShowUpload] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const livePreviewRef = useRef<HTMLVideoElement | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Guards against a double-invocation (e.g. a fast repeat click) spinning up
  // two concurrent getUserMedia streams before `recording` state flips.
  const startingRef = useRef(false);
  // Mirror of the current preview object URL, so the unmount cleanup can revoke
  // it without depending on the `recorded` state (which would re-run the effect
  // and revoke the URL mid-preview).
  const recordedUrlRef = useRef<string | null>(null);
  // Last upload attempt (blob/contentType/duration), so a network failure can
  // offer a one-click retry instead of forcing a full re-record/re-pick.
  const lastAttemptRef = useRef<{
    blob: Blob;
    contentType: string;
    durationMs: number | null;
    source: "record" | "upload";
  } | null>(null);

  const revokePreview = useCallback(() => {
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current);
    recordedUrlRef.current = null;
  }, []);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (livePreviewRef.current) livePreviewRef.current.srcObject = null;
  }, []);

  const clearTimers = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    stopTimerRef.current = null;
    tickRef.current = null;
  }, []);

  // Cleanup on unmount: stop the camera and revoke any preview object URL.
  // Reads the URL from a ref so the effect's deps stay stable (runs once).
  useEffect(() => {
    return () => {
      clearTimers();
      stopTracks();
      revokePreview();
    };
  }, [clearTimers, stopTracks, revokePreview]);

  // Fixes a black-preview race: startRecording assigns `srcObject` to
  // `livePreviewRef` as soon as getUserMedia resolves, but at that instant
  // `recording` is still false, so the <video> element (only rendered while
  // recording || recorded) isn't mounted yet — the assignment silently no-ops
  // and nothing ever re-attaches the stream once `setRecording(true)` mounts
  // it. This effect runs after React commits that newly-rendered element, so
  // the ref is guaranteed attached by then — the authoritative fix; the
  // inline assignment in startRecording stays as a harmless fallback.
  useEffect(() => {
    if (recording && livePreviewRef.current && streamRef.current) {
      livePreviewRef.current.srcObject = streamRef.current;
      void livePreviewRef.current.play().catch(() => {});
    }
  }, [recording]);

  // Presign → PUT straight to R2 → finalize. The bytes never go through the
  // Server Action, so any allowed size up to the 50 MB cap works.
  const doUpload = useCallback(
    async (
      blob: Blob,
      contentType: string,
      durationMs: number | null,
      source: "record" | "upload",
    ) => {
      lastAttemptRef.current = { blob, contentType, durationMs, source };
      setUploadState(undefined);
      setUploading(true);
      // Size + duration ride along on every upload event so a failure rate can
      // be read against what was actually being uploaded — "uploads fail" and
      // "uploads over 30 MB fail" are different bugs with different fixes.
      const shape = { source, size_bytes: blob.size, duration_ms: durationMs };
      track("intro_video_upload_started", shape);
      const failed = (reason: string) => track("intro_video_upload_failed", { ...shape, reason });
      try {
        const pre = await presignIntroVideoUploadAction(contentType);
        if (!pre.ok) {
          failed("presign-rejected");
          setUploadState({ error: pre.error });
          return;
        }
        const put = await fetch(pre.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: blob,
        });
        if (!put.ok) {
          failed(`r2-put-${put.status}`);
          setUploadState({ error: t("bookingPage.videoError.upload-failed") });
          return;
        }
        const res = await finalizeIntroVideoAction(durationMs, source);
        setUploadState(res);
        if (res?.ok) {
          lastAttemptRef.current = null;
          revokePreview();
          setRecorded(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
          router.refresh(); // pull the freshly-stored videoUrl from the server component
        } else {
          // The server rejected the finalize (missing object / over the cap).
          failed("finalize-rejected");
        }
      } catch {
        failed("network");
        setUploadState({ error: t("bookingPage.videoError.upload-failed") });
      } finally {
        setUploading(false);
      }
    },
    [t, router, revokePreview, track],
  );

  // Re-attempts the same upload after a network failure, instead of forcing a
  // full re-record/re-pick — the recorded blob / picked file is still on hand.
  const retryUpload = useCallback(() => {
    const last = lastAttemptRef.current;
    if (!last) return;
    track("intro_video_upload_retried", { source: last.source, size_bytes: last.blob.size });
    void doUpload(last.blob, last.contentType, last.durationMs, last.source);
  }, [doUpload, track]);

  const stopRecording = useCallback(() => {
    clearTimers();
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, [clearTimers]);

  const startRecording = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setRecorderError(null);
    revokePreview();
    setRecorded(null);
    // The top of the teacher funnel. Split from `recording_started` below
    // because the camera-permission prompt sits between them — a big gap
    // between the two events IS the permission-denial problem, and the server
    // can never see either.
    track("intro_video_recorder_opened", { has_existing_video: Boolean(videoUrl) });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });
      streamRef.current = stream;
      if (livePreviewRef.current) {
        livePreviewRef.current.srcObject = stream;
        void livePreviewRef.current.play().catch(() => {});
      }

      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const durationMs = Date.now() - startedAtRef.current;
        const type = rec.mimeType || mimeType || "video/webm";
        const blob = new Blob(chunksRef.current, { type });
        stopTracks();
        setRecording(false);
        setElapsedMs(0);
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          recordedUrlRef.current = url;
          setRecorded({ blob, url, durationMs });
          track("intro_video_recording_completed", {
            duration_ms: durationMs,
            size_bytes: blob.size,
            // Whether the 60s hard stop ended the take rather than the teacher.
            // A high rate here means the cap is fighting teachers, not helping.
            hit_cap: durationMs >= MAX_RECORD_MS - 500,
            length_verdict: introVideoLengthVerdict(Math.round(durationMs / 1000)),
          });
        } else {
          track("intro_video_recording_failed", { reason: "empty-blob" });
        }
      };

      startedAtRef.current = Date.now();
      rec.start();
      track("intro_video_recording_started");
      setRecording(true);
      setElapsedMs(0);
      tickRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 250);
      // Hard stop at the cap.
      stopTimerRef.current = setTimeout(stopRecording, MAX_RECORD_MS);
    } catch (err) {
      stopTracks();
      setRecording(false);
      const name = err instanceof Error ? err.name : undefined;
      track("intro_video_recording_failed", { reason: name ?? "unknown" });
      // The recorder just failed — most often a denied camera/mic permission,
      // which the teacher may not be able to undo without leaving the page.
      // Surface the upload path immediately rather than leaving her with a red
      // error and no route forward. This is the whole reason upload survives.
      setShowUpload(true);
      setRecorderError(
        name === "NotAllowedError"
          ? t("web.settings.bookingPage.video.cameraPermissionDenied")
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? t("web.settings.bookingPage.video.cameraNotFound")
            : t("web.settings.bookingPage.video.cameraError"),
      );
    } finally {
      startingRef.current = false;
    }
  }, [t, revokePreview, stopRecording, stopTracks, track, videoUrl]);

  const saveRecorded = useCallback(() => {
    if (!recorded) return;
    void doUpload(recorded.blob, recorded.blob.type || "video/webm", recorded.durationMs, "record");
  }, [recorded, doUpload]);

  const uploadPickedFile = useCallback(async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    // A picked file used to be stored with `durationMs: null`, which quietly
    // blinded the AI coach: its checklist explicitly judges "a length around
    // 30–60 seconds", and with no duration it was told "Video length: unknown"
    // for every uploaded clip. The browser already knows the answer — read it
    // off a detached <video> before uploading.
    const durationMs = await readVideoDurationMs(file);
    void doUpload(file, file.type || "video/mp4", durationMs, "upload");
  }, [doUpload]);

  const secs = Math.floor(elapsedMs / 1000);
  const lengthVerdict = recorded
    ? introVideoLengthVerdict(Math.round(recorded.durationMs / 1000))
    : null;

  return (
    <div className="space-y-4">
      {videoUrl && !recorded && (
        <video
          src={videoUrl}
          controls
          playsInline
          preload="metadata"
          className="w-full max-w-xs rounded-lg border bg-black"
        />
      )}

      {/* AI coach feedback (D-73, Layer 3) — teacher-only, shown when generated
          or while processing.

          It used to be hidden whenever `recording || recorded` was true, i.e.
          it disappeared the moment she started a retake — exactly when the
          advice is being acted on, and the only reason to retake. It now stays
          up through the retake and only yields while the live camera preview
          is on screen (where the panel would push the preview out of view on a
          laptop). */}
      <IntroVideoCoachPanel initial={analysis} hidden={recording} />

      {/* What to say. The single most common reason a teacher opens the
          recorder and closes it again is not knowing what to put in 45
          seconds — the card's only guidance was "a short 30-60s hello". Four
          beats, visible while the camera is live, turn a blank-page problem
          into a fill-in-the-blanks one. Deliberately prompts, not a verbatim
          script: a read-aloud script is the thing that makes an intro sound
          rehearsed, which is the exact failure the AI coach then flags. */}
      {!recorded && (
        <div className="rounded-lg border bg-muted/40 p-3">
          <p className="text-sm font-medium">{t("web.settings.bookingPage.video.scriptTitle")}</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-muted-foreground">
            <li>{t("web.settings.bookingPage.video.scriptBeat1")}</li>
            <li>{t("web.settings.bookingPage.video.scriptBeat2")}</li>
            <li>{t("web.settings.bookingPage.video.scriptBeat3")}</li>
            <li>{t("web.settings.bookingPage.video.scriptBeat4")}</li>
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("web.settings.bookingPage.video.scriptHint")}
          </p>
        </div>
      )}

      {/* Recorder */}
      <div className="space-y-2">
        {(recording || recorded) && (
          <div className="relative w-full max-w-xs">
            {recording ? (
              <video
                ref={livePreviewRef}
                muted
                playsInline
                className="w-full rounded-lg border bg-black"
              />
            ) : recorded ? (
              <video
                src={recorded.url}
                controls
                playsInline
                className="w-full rounded-lg border bg-black"
              />
            ) : null}
            {recording && (
              <span className="absolute top-2 left-2 rounded bg-destructive px-2 py-0.5 text-xs font-medium text-destructive-foreground">
                {`● ${secs}s`}
              </span>
            )}
          </div>
        )}

        {/* An immediate, local length check. The AI coach makes the same
            judgement, but only minutes later and only for Pro teachers — by
            which point the clip is already public. This costs nothing and
            reaches every teacher while a retake is still one tap away. */}
        {recorded && !recording && lengthVerdict !== "ideal" && (
          <p className="text-sm text-muted-foreground">
            {lengthVerdict === "too-short"
              ? t("web.settings.bookingPage.video.lengthTooShort", {
                  min: INTRO_VIDEO_IDEAL_MIN_SEC,
                })
              : t("web.settings.bookingPage.video.lengthTooLong", {
                  max: INTRO_VIDEO_IDEAL_MAX_SEC,
                })}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {!recording && (
            <Button type="button" onClick={startRecording} disabled={uploading}>
              {recorded ? t("bookingPage.reRecordVideo") : t("bookingPage.recordVideo")}
            </Button>
          )}
          {recording && (
            <Button type="button" variant="destructive" onClick={stopRecording}>
              {t("web.settings.bookingPage.video.stop")}
            </Button>
          )}
          {recorded && !recording && (
            <Button type="button" onClick={saveRecorded} disabled={uploading}>
              {uploading
                ? t("web.settings.bookingPage.video.uploading")
                : t("web.settings.bookingPage.video.save")}
            </Button>
          )}
        </div>
        {recorderError && <p className="text-sm text-destructive">{recorderError}</p>}
      </div>

      {/* Upload — the secondary path. A quiet disclosure rather than a co-equal
          button with its own file input and CTA, so there is one obvious thing
          to do on this card. Opens automatically when the recorder fails. */}
      {!recording && !recorded && (
        <div className="border-t pt-4">
          {!showUpload ? (
            <button
              type="button"
              onClick={() => {
                // How many teachers even consider uploading is the input to
                // "should this path exist at all" question the review asked — a click here is
                // intent, which `teacher_intro_video_set` alone can't show
                // because it only fires for uploads that succeed.
                track("intro_video_upload_revealed");
                setShowUpload(true);
              }}
              className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("web.settings.bookingPage.video.haveVideoAlready")}
            </button>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="video">{t("web.settings.bookingPage.video.orUpload")}</Label>
              <input
                ref={fileInputRef}
                id="video"
                name="video"
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                disabled={uploading}
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
              />
              <p className="text-xs text-muted-foreground">
                {t("web.settings.bookingPage.video.uploadHelp")}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void uploadPickedFile()}
                disabled={uploading}
              >
                {uploading
                  ? t("web.settings.bookingPage.video.uploading")
                  : t("web.settings.bookingPage.video.uploadCta")}
              </Button>
            </div>
          )}
        </div>
      )}

      <FormStatus state={uploadState} savedMessage={t("bookingPage.videoUpdated")} />
      {uploadState?.error && lastAttemptRef.current && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={retryUpload}
          disabled={uploading}
        >
          {t("web.settings.bookingPage.video.retryUpload")}
        </Button>
      )}

      {videoUrl && !recording && !recorded && (
        <form action={removeAction}>
          <Button type="submit" variant="ghost" size="sm" disabled={removing}>
            {removing ? t("web.settings.bookingPage.video.removing") : t("bookingPage.removeVideo")}
          </Button>
          <FormStatus state={removeState} />
        </form>
      )}
    </div>
  );
}
