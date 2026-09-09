"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Selfie video recorder — front camera + mic via MediaRecorder.
//
// Lifted out of chat-room.tsx unchanged, so it sits beside its audio twin
// (use-voice-recorder.ts) instead of being a 130-line hook buried in the
// middle of a component file.
export type VideoRecorderState = "idle" | "recording";
export type VideoRecorderResult = { blob: Blob; mimeType: string; durationMs: number };

export function useVideoRecorder() {
  const [state, setState] = useState<VideoRecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobEvent["data"][]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef(0);
  const resolveRef = useRef<((r: VideoRecorderResult | null) => void) | null>(null);

  const previewRef = useRef<HTMLVideoElement>(null);

  // Release camera/mic and cancel timers if the component unmounts while recording.
  useEffect(() => {
    return () => {
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const startRecording = useCallback(async (): Promise<boolean> => {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });
      streamRef.current = stream;

      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        previewRef.current.play().catch(() => {});
      }

      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];
      startTimeRef.current = Date.now();
      setElapsedMs(0);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const durationMs = Date.now() - startTimeRef.current;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        stream!.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (previewRef.current) previewRef.current.srcObject = null;
        const cb = resolveRef.current;
        resolveRef.current = null;
        cb?.({ blob, mimeType, durationMs });
      };

      recorder.start(250);
      setState("recording");
      timerRef.current = setInterval(() => setElapsedMs(Date.now() - startTimeRef.current), 200);

      // Auto-stop at 60 s
      autoStopRef.current = setTimeout(
        () => recorder.state === "recording" && recorder.stop(),
        60_000,
      );

      return true;
    } catch {
      // Clean up the stream if it was acquired before the failure.
      stream?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      return false;
    }
  }, []);

  const stopRecording = useCallback((): Promise<VideoRecorderResult | null> => {
    return new Promise((resolve) => {
      if (autoStopRef.current) {
        clearTimeout(autoStopRef.current);
        autoStopRef.current = null;
      }
      if (timerRef.current) clearInterval(timerRef.current);
      setElapsedMs(0);
      if (!recorderRef.current || recorderRef.current.state === "inactive") {
        setState("idle");
        resolve(null);
        return;
      }
      // Store resolve BEFORE calling stop() so onstop never races past it.
      resolveRef.current = resolve;
      // Transition to idle only after onstop fires (keeps preview alive until then).
      recorderRef.current.addEventListener("stop", () => setState("idle"), { once: true });
      recorderRef.current.stop();
    });
  }, []);

  const cancelRecording = useCallback(() => {
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    // Resolve any pending stopRecording promise with null before nulling the ref,
    // so callers don't hang if cancelRecording races stopRecording.
    const pending = resolveRef.current;
    resolveRef.current = null;
    pending?.(null);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
    setState("idle");
    setElapsedMs(0);
  }, []);

  return { state, elapsedMs, previewRef, startRecording, stopRecording, cancelRecording };
}
