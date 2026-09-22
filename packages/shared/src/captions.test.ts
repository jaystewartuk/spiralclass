import { describe, expect, it } from "vitest";
import {
  CAPTION_TOPIC,
  CAPTIONS_AGENT_IDENTITY,
  decodeCaption,
  encodeCaption,
  humanRemotes,
  isCaptionsAgentIdentity,
  type CaptionMessage,
} from "./captions";

// The shared caption wire format used by both web and mobile. Pins the
// round-trip, the required recipient (`for`) field, and the defensive decode
// (a malformed or foreign packet must degrade to null, never throw into a
// DataReceived handler).

describe("encode/decode round-trip", () => {
  it("round-trips a line message", () => {
    const msg: CaptionMessage = { t: "line", for: "student-1", id: "7", text: "How are you?" };
    expect(decodeCaption(encodeCaption(msg))).toEqual(msg);
  });

  it("round-trips non-ASCII text (accented Spanish/English)", () => {
    const msg: CaptionMessage = {
      t: "line",
      for: "teacher-1",
      id: "8",
      text: "¿Cómo estás? — fine, thanks",
    };
    expect(decodeCaption(encodeCaption(msg))).toEqual(msg);
  });

  it("round-trips a state message both ways", () => {
    expect(decodeCaption(encodeCaption({ t: "state", for: "student-1", on: true }))).toEqual({
      t: "state",
      for: "student-1",
      on: true,
    });
    expect(decodeCaption(encodeCaption({ t: "state", for: "student-1", on: false }))).toEqual({
      t: "state",
      for: "student-1",
      on: false,
    });
  });
});

describe("decodeCaption defensive parsing", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("returns null on non-JSON", () => {
    expect(decodeCaption(bytes("not json"))).toBeNull();
  });

  it("returns null on a foreign / unknown message", () => {
    expect(decodeCaption(bytes(JSON.stringify({ t: "other", for: "x" })))).toBeNull();
    expect(decodeCaption(bytes(JSON.stringify({ hello: "world" })))).toBeNull();
    expect(decodeCaption(bytes(JSON.stringify(42)))).toBeNull();
  });

  it("returns null when required fields are missing or wrong-typed", () => {
    expect(
      decodeCaption(bytes(JSON.stringify({ t: "line", for: "x", id: 1, text: "x" }))),
    ).toBeNull();
    expect(decodeCaption(bytes(JSON.stringify({ t: "line", for: "x", id: "1" })))).toBeNull();
    expect(decodeCaption(bytes(JSON.stringify({ t: "state", for: "x", on: "yes" })))).toBeNull();
  });

  it("returns null when the recipient (`for`) field is missing or empty", () => {
    expect(decodeCaption(bytes(JSON.stringify({ t: "line", id: "1", text: "x" })))).toBeNull();
    expect(
      decodeCaption(bytes(JSON.stringify({ t: "line", for: "", id: "1", text: "x" }))),
    ).toBeNull();
    expect(decodeCaption(bytes(JSON.stringify({ t: "state", for: 7, on: true })))).toBeNull();
  });

  it("exposes a namespaced topic", () => {
    expect(CAPTION_TOPIC).toBe("captions");
  });
});

// The enrichment fields (`src`, `from`, `lang`, `srcLang`) turn a subtitle
// into a language lesson: what was actually said, by whom, in which language.
// They are OPTIONAL on the wire because any client running an older build
// predates them, and every one of those must keep rendering subtitles
// unchanged.
describe("decodeCaption enrichment fields", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("round-trips a fully enriched line", () => {
    const msg: CaptionMessage = {
      t: "line",
      for: "student-1",
      id: "9",
      text: "How are you?",
      src: "¿Cómo estás?",
      from: "teacher-1",
      lang: "en",
      srcLang: "es",
    };
    expect(decodeCaption(encodeCaption(msg))).toEqual(msg);
  });

  it("decodes a line with none of them — the pre-enrichment wire format", () => {
    // A client running an older build still sends exactly this. It must
    // decode to a usable line.
    expect(
      decodeCaption(bytes(JSON.stringify({ t: "line", for: "x", id: "1", text: "hola" }))),
    ).toEqual({ t: "line", for: "x", id: "1", text: "hola" });
  });

  it("DROPS a malformed enrichment field without failing the whole line", () => {
    // The line is still showable without any of these. A receiver that threw
    // away a perfectly good subtitle over a junk `lang` attribute would be
    // trading the feature for the garnish.
    const decoded = decodeCaption(
      bytes(
        JSON.stringify({
          t: "line",
          for: "x",
          id: "1",
          text: "hello",
          src: 42,
          from: "",
          lang: null,
          srcLang: "es",
        }),
      ),
    );
    expect(decoded).toEqual({ t: "line", for: "x", id: "1", text: "hello", srcLang: "es" });
  });
});

describe("isCaptionsAgentIdentity / humanRemotes", () => {
  it("identifies the Agent's participant identity", () => {
    expect(isCaptionsAgentIdentity(CAPTIONS_AGENT_IDENTITY)).toBe(true);
    expect(isCaptionsAgentIdentity("some-student-uuid")).toBe(false);
    expect(isCaptionsAgentIdentity(undefined)).toBe(false);
    expect(isCaptionsAgentIdentity(null)).toBe(false);
  });

  // The regression guard. The captions Agent joins every caption-enabled class
  // room as a real remote participant, so `remoteParticipants` is NOT a list of
  // humans. Production 2026-07-26→29: "open this material for the student"
  // addressed its message to remoteParticipants[0], which could be the Agent —
  // the student never received it, and nothing errored, because a client
  // correctly ignores a message not addressed to itself.
  it("excludes the Agent when picking the other person in the call", () => {
    const remotes = [{ identity: CAPTIONS_AGENT_IDENTITY }, { identity: "student-1" }];
    expect(humanRemotes(remotes)).toEqual([{ identity: "student-1" }]);
    // Order must not matter: whichever the SDK yields first, the human wins.
    expect(humanRemotes([...remotes].reverse())).toEqual([{ identity: "student-1" }]);
  });

  it("reports an Agent-only room as having nobody else in it", () => {
    // Drives "is the other person here?" — the waiting-room state, the
    // swap-video affordance and the open-for choice sheet all read this.
    expect(humanRemotes([{ identity: CAPTIONS_AGENT_IDENTITY }])).toEqual([]);
    expect(humanRemotes([])).toEqual([]);
  });

  it("preserves the full participant object, not just the identity", () => {
    const student = { identity: "student-1", sid: "PA_x" };
    expect(humanRemotes([student])[0]).toBe(student);
  });
});
