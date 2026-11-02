import { captionCutPoint, captionRemainder, type CaptionTiming } from "@spiralclass/shared";

// Cuts a speaker's utterance short of the browser's own "final", on the
// teacher's timing (caption-timing.ts). One per running speaker.
//
// The recogniser reports what it has heard so far for the utterance in
// flight (`partial`) and, much later when the speaker finally pauses, the
// whole utterance (`final`). This sits between them: when the heard text has
// stopped growing for `pauseMs`, or has grown past `maxChars`, the part not
// yet delivered is handed to `cut` as if it were a finished line. The
// utterance carries on; the part already cut is remembered so neither the
// partials that follow nor the browser's eventual final repeat it.
//
// With both dials at 0 nothing here ever cuts, and `partial` / `final` hand
// the text straight back — the behaviour before the dials existed.

export type CaptionChunkerOptions = {
  // Read on every event, so a change to the teacher's settings applies to the
  // utterance already in flight without restarting anything.
  timing: () => CaptionTiming;
  // A part of the utterance to deliver now, as a finished line.
  cut: (text: string) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export class CaptionChunker {
  private readonly opts: Required<CaptionChunkerOptions>;
  // What has been cut from the utterance in flight, joined as the recogniser
  // spelled it, so it can be told apart from what is still being heard.
  private cutText = "";
  // The undelivered part as of the last partial: what the timer cuts.
  private waiting = "";
  private lastHeard = "";
  private timer: unknown = null;

  constructor(options: CaptionChunkerOptions) {
    this.opts = {
      timing: options.timing,
      cut: options.cut,
      setTimeout: options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
      clearTimeout:
        options.clearTimeout ??
        ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  // The recogniser heard `heard` of the utterance in flight. Returns the part
  // of it still undelivered, for the partial line ("" when there is nothing
  // to show).
  partial(heard: string): string {
    this.clearTimer();
    let rest = captionRemainder(this.cutText, heard);
    const { pauseMs, maxChars } = this.opts.timing();

    const at = captionCutPoint(rest, maxChars);
    if (at > 0) {
      const head = rest.slice(0, at).trim();
      rest = rest.slice(at).trim();
      if (head) this.deliver(head, heard, rest);
    }

    this.waiting = rest;
    this.lastHeard = heard;
    if (pauseMs > 0 && rest) {
      this.timer = this.opts.setTimeout(() => {
        this.timer = null;
        const text = this.waiting;
        this.waiting = "";
        if (text) this.deliver(text, this.lastHeard, "");
      }, pauseMs);
    }
    return rest;
  }

  // The browser finished the utterance. Returns the part not already cut,
  // "" when everything was; the next utterance starts clean either way.
  final(text: string): string {
    this.clearTimer();
    const rest = captionRemainder(this.cutText, text);
    this.reset();
    return rest;
  }

  stop(): void {
    this.clearTimer();
    this.reset();
  }

  private deliver(head: string, heard: string, rest: string): void {
    // What the recogniser has spelled up to the cut: everything it has heard
    // less what is still waiting. Kept in its own spelling so the next
    // partial's prefix matches exactly.
    this.cutText = rest ? heard.slice(0, heard.length - rest.length).trim() : heard.trim();
    this.opts.cut(head);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.opts.clearTimeout(this.timer);
    this.timer = null;
  }

  private reset(): void {
    this.cutText = "";
    this.waiting = "";
    this.lastHeard = "";
  }
}
