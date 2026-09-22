import { describe, expect, it, vi } from "vitest";
import type { CallMaterial } from "./api";
import {
  CALL_MATERIAL_OPEN_TOPIC,
  decodeCallMaterialOpen,
  encodeCallMaterialOpen,
  type CallMaterialOpenMessage,
} from "./call-material-open";

// The shared "open this material for the other participant" wire format,
// mirroring captions.test.ts's coverage: pins the round-trip, the required
// recipient (`for`) field, and defensive decode (a malformed/foreign packet
// degrades to null, never throws into a DataReceived handler).

describe("encode/decode round-trip", () => {
  it("round-trips a content material", () => {
    const msg: CallMaterialOpenMessage = {
      for: "student-1",
      material: {
        id: "m1",
        kind: "content",
        label: "Present tense",
        body: "# Hi",
        viewUrl: null,
        fileKind: null,
      },
    };
    expect(decodeCallMaterialOpen(encodeCallMaterialOpen(msg))).toEqual(msg);
  });

  it("round-trips a file material with null label/body", () => {
    const msg: CallMaterialOpenMessage = {
      for: "teacher-1",
      material: {
        id: "m2",
        kind: "file",
        label: null,
        body: null,
        viewUrl: "https://x/y.pdf",
        fileKind: "pdf",
      },
    };
    expect(decodeCallMaterialOpen(encodeCallMaterialOpen(msg))).toEqual(msg);
  });

  it("carries fileKind, which is what decides whether the receiver renders it in the call", () => {
    const send = (fileKind: CallMaterial["fileKind"]): CallMaterialOpenMessage => ({
      for: "student-1",
      material: {
        id: "m3",
        kind: "file",
        label: "Worksheet",
        body: null,
        viewUrl: "https://x/y",
        fileKind,
      },
    });
    for (const kind of ["pdf", "image", "other"] as const) {
      expect(decodeCallMaterialOpen(encodeCallMaterialOpen(send(kind)))?.material.fileKind).toBe(
        kind,
      );
    }
  });
});

describe("decodeCallMaterialOpen defensive parsing", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("returns null on non-JSON", () => {
    expect(decodeCallMaterialOpen(bytes("not json"))).toBeNull();
  });

  it("returns null when the recipient (`for`) field is missing or empty", () => {
    expect(
      decodeCallMaterialOpen(bytes(JSON.stringify({ material: { id: "m1", kind: "content" } }))),
    ).toBeNull();
    expect(
      decodeCallMaterialOpen(
        bytes(JSON.stringify({ for: "", material: { id: "m1", kind: "content" } })),
      ),
    ).toBeNull();
  });

  it("returns null when material is missing or malformed", () => {
    expect(decodeCallMaterialOpen(bytes(JSON.stringify({ for: "x" })))).toBeNull();
    expect(
      decodeCallMaterialOpen(bytes(JSON.stringify({ for: "x", material: { kind: "content" } }))),
    ).toBeNull();
    expect(
      decodeCallMaterialOpen(
        bytes(JSON.stringify({ for: "x", material: { id: "m1", kind: "bogus" } })),
      ),
    ).toBeNull();
  });

  it("degrades an unknown or absent fileKind to null rather than dropping the packet", () => {
    // A sender on an older build puts no fileKind on the wire at all. The
    // material must still open — outside the call, which is what it did
    // before the field existed — instead of vanishing with no error.
    const packet = (fileKind: unknown) =>
      bytes(
        JSON.stringify({
          for: "student-1",
          material: {
            id: "m1",
            kind: "file",
            label: null,
            body: null,
            viewUrl: "https://x/y.pdf",
            ...(fileKind === undefined ? {} : { fileKind }),
          },
        }),
      );
    expect(decodeCallMaterialOpen(packet(undefined))?.material.fileKind).toBeNull();
    expect(decodeCallMaterialOpen(packet("spreadsheet"))?.material.fileKind).toBeNull();
    expect(decodeCallMaterialOpen(packet(7))?.material.fileKind).toBeNull();
  });

  it("exposes a namespaced topic", () => {
    expect(CALL_MATERIAL_OPEN_TOPIC).toBe("call-material-open");
  });
});

// The answer-key guarantee for the shared material view: a teacher opening a
// material on the student's screen must not put the solutions on the student's
// device. The strip happens at BOTH ends of this channel — see the module
// header for why the decode-side one is load-bearing rather than redundant.
// It is a BODY guarantee: a file (PDF/image) travels as a signed URL to opaque
// bytes with no answer structure to cut, which call-material.test.ts pins.
describe("answer keys never ride this channel in a content body", () => {
  const ANSWERED = [
    "> [!exercise]",
    "> Complete the gap: She (go) to school.",
    "",
    "> [!answer]",
    "> goes",
    "",
    "> [!question] Why?",
    "> Third person singular.",
    ">",
    "> > [!answer]",
    "> > Because the subject is 'she'.",
  ].join("\n");

  const send = (body: string): CallMaterialOpenMessage => ({
    for: "student-1",
    material: {
      id: "m1",
      kind: "content",
      label: "Present simple",
      body,
      viewUrl: null,
      fileKind: null,
    },
  });

  it("encode leaves no answer text in the bytes that go on the wire", () => {
    // Asserted over the raw packet, not the decoded object: this is the thing
    // that crosses the network and lands in the receiver's memory.
    const wire = new TextDecoder().decode(encodeCallMaterialOpen(send(ANSWERED)));
    expect(wire).toContain("Complete the gap");
    expect(wire).toContain("Third person singular.");
    expect(wire).not.toContain("[!answer]");
    expect(wire).not.toContain("goes");
    expect(wire).not.toContain("Because the subject is");
  });

  it("encode keeps the exercise, the question and every non-body field intact", () => {
    const out = decodeCallMaterialOpen(encodeCallMaterialOpen(send(ANSWERED)));
    expect(out?.for).toBe("student-1");
    expect(out?.material.id).toBe("m1");
    expect(out?.material.kind).toBe("content");
    expect(out?.material.label).toBe("Present simple");
    expect(out?.material.body).toContain("[!exercise]");
    expect(out?.material.body).toContain("[!question]");
  });

  it("decode strips a packet an older sender build published unstripped", () => {
    // Web and mobile shipped independently, so a teacher on a
    // pre-fix mobile build keeps publishing the full body for as long as that
    // build lives. Hand-built here rather than via encodeCallMaterialOpen,
    // which is exactly what such a sender would put on the topic.
    const legacy = new TextEncoder().encode(JSON.stringify(send(ANSWERED)));
    const out = decodeCallMaterialOpen(legacy);
    expect(out?.material.body).toContain("Complete the gap");
    expect(out?.material.body).not.toContain("[!answer]");
    expect(out?.material.body).not.toContain("goes");
    expect(out?.material.body).not.toContain("Because the subject is");
  });

  it("survives a material that is nothing but an answer key", () => {
    const out = decodeCallMaterialOpen(encodeCallMaterialOpen(send("> [!answer]\n> 42")));
    expect(out?.material.body).toBe("");
    expect(out?.material.kind).toBe("content");
  });
});

describe("the strip cannot fail open", () => {
  it("drops the packet rather than delivering an unstripped body", async () => {
    // The strip parses the body, so it is the one step in decode that runs
    // non-trivial logic over attacker-shaped input. If it ever throws, the
    // packet must be discarded like any other malformed one — falling back to
    // the body as sent would hand over the exact bytes the strip removes.
    const mod = await import("./call-material");
    const spy = vi.spyOn(mod, "studentCallMaterial").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          for: "student-1",
          material: {
            id: "m1",
            kind: "content",
            label: null,
            body: "> [!answer]\n> goes",
            viewUrl: null,
          },
        }),
      );
      expect(decodeCallMaterialOpen(bytes)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
