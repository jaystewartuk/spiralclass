// Structured logging to stdout — picked up by `docker compose logs`, the
// pragmatic ceiling for this box (no APM/Prometheus exists here today, per
// the infra audit). One JSON line per event so it greps/parses cleanly.

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

// Per-utterance latency breakdown (the captions architecture review
// From the captions latency review — nothing previously measured where the reported "several seconds"
// actually went). Call mark() at each stage boundary; done() logs the deltas.
export class UtteranceTiming {
  private readonly marks: Array<{ stage: string; at: number }> = [];

  // startAt defaults to Date.now() (the old behavior, a no-op "start" mark)
  // but a caller with a real end-of-speech timestamp (deepgram.ts's
  // audioEndAtMs) should pass it — that turns the first mark() delta into
  // genuine ASR latency instead of always reading ~0ms.
  constructor(
    private readonly room: string,
    startAt: number = Date.now(),
  ) {
    this.marks.push({ stage: "start", at: startAt });
  }

  mark(stage: string): void {
    this.marks.push({ stage, at: Date.now() });
  }

  done(): void {
    const deltas: Record<string, number> = {};
    for (let i = 1; i < this.marks.length; i++) {
      const prev = this.marks[i - 1];
      const cur = this.marks[i];
      deltas[`${prev.stage}->${cur.stage}Ms`] = cur.at - prev.at;
    }
    const first = this.marks[0];
    const last = this.marks[this.marks.length - 1];
    logEvent("utterance_timing", {
      room: this.room,
      totalMs: last.at - first.at,
      ...deltas,
    });
  }
}
