"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { TFunction } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { formatElapsed } from "@/lib/chat/view-model";
import { cn } from "@/lib/utils";

/**
 * A voice note's player, rendered INSIDE the message bubble shell (which owns
 * the background, the corners and the footer) rather than painting its own.
 *
 * The scrubber is a real `<input type="range">`. The previous version drew a
 * `<div>` progress bar, which meant a voice note could not be seeked at all —
 * not by mouse, not by keyboard — and announced nothing to a screen reader.
 * A range input is seekable by drag and by arrow key, and reports its position
 * for free.
 */
export function VoiceMessage({
  voiceUrl,
  durationMs,
  fromMe,
  t,
}: {
  voiceUrl: string;
  durationMs: number | null;
  fromMe: boolean;
  t: TFunction;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [totalMs, setTotalMs] = useState(durationMs ?? 0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentMs(audio.currentTime * 1000);
    const onDuration = () => {
      if (!isNaN(audio.duration) && isFinite(audio.duration)) setTotalMs(audio.duration * 1000);
    };
    const onEnded = () => {
      setPlaying(false);
      setCurrentMs(0);
      audio.currentTime = 0;
    };
    const onPause = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("pause", onPause);
    };
  }, []);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      // Autoplay policy or a network error — the control simply stays paused.
    }
  };

  const seek = (ms: number) => {
    const audio = audioRef.current;
    setCurrentMs(ms);
    if (audio) audio.currentTime = ms / 1000;
  };

  // Counting DOWN while playing is the voice-note convention: what is left to
  // listen to is the useful number, not what has elapsed.
  const remaining = playing && totalMs > currentMs ? totalMs - currentMs : totalMs;

  return (
    <div className="flex min-w-attachment items-center gap-3">
      <audio ref={audioRef} src={voiceUrl} preload="metadata" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={toggle}
        aria-label={playing ? t("chat.voice.pause") : t("chat.voice.play")}
        className={cn(
          "shrink-0 rounded-full",
          fromMe
            ? "bg-overlay-1 text-primary-foreground hover:bg-overlay-2 hover:text-primary-foreground"
            : "bg-muted text-foreground",
        )}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      <input
        type="range"
        min={0}
        max={Math.max(totalMs, 1)}
        step={100}
        value={Math.min(currentMs, totalMs)}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label={t("chat.voice.seek")}
        aria-valuetext={formatElapsed(currentMs)}
        className={cn(
          "h-1.5 min-w-0 flex-1 cursor-pointer",
          fromMe ? "accent-primary-foreground" : "accent-primary",
        )}
      />
      <span
        className={cn(
          "shrink-0 text-sm tabular-nums",
          fromMe ? "text-primary-foreground" : "text-muted-foreground",
        )}
      >
        {formatElapsed(remaining)}
      </span>
    </div>
  );
}
