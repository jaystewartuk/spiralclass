import { describe, expect, it } from "vitest";

import {
  clearTimelineSpan,
  defaultTimelineSpan,
  insertBlockAt,
  insertTimelinePoint,
  newTimelineBlock,
  removeTimelinePoint,
  setTimelineSpan,
  updateTimelineLabel,
  updateTimelinePointAt,
  updateTimelinePointLabel,
  updateTimelineSpanLabel,
} from "./block-editor";
import { extractHomeworkExcerptText, parseBlockText, parseMaterialDoc } from "./parse";
import { serializeBlock, serializeMaterialDoc } from "./serialize";
import {
  isRepresentableTimeline,
  timelineGeometry,
  timelineX,
  TIMELINE_MAX_POINTS,
  TIMELINE_NOW,
  TIMELINE_VIEW_HEIGHT,
  TIMELINE_VIEW_WIDTH,
} from "./timeline";
import type { MaterialBlock, TimelineBlock } from "./types";

function fence(...lines: string[]): string {
  return ["```timeline", ...lines, "```"].join("\n");
}

function timeline(overrides: Partial<TimelineBlock> = {}): TimelineBlock {
  return {
    type: "timeline",
    labels: { past: "Past", now: "Now", future: "Future" },
    span: null,
    points: [],
    ...overrides,
  };
}

/** The one timeline every test that just needs "a valid one" uses. */
function sample(): TimelineBlock {
  return timeline({
    span: { from: 20, to: 50, label: "have lived here" },
    points: [{ at: 20, label: "I moved to Mérida" }],
  });
}

describe("parsing a timeline fence", () => {
  it("reads a full payload", () => {
    const body = fence(
      "past Antes",
      "now Ahora",
      "future Después",
      "span 20 50 have lived here",
      "point 20 I moved to Mérida",
    );
    expect(parseMaterialDoc(body).blocks).toEqual([
      timeline({
        labels: { past: "Antes", now: "Ahora", future: "Después" },
        span: { from: 20, to: 50, label: "have lived here" },
        points: [{ at: 20, label: "I moved to Mérida" }],
      }),
    ]);
  });

  it("defaults the axis labels when the payload omits them", () => {
    const doc = parseMaterialDoc(fence("point 70 next summer"));
    expect(doc.blocks).toEqual([timeline({ points: [{ at: 70, label: "next summer" }] })]);
  });

  it("keeps a deliberately-cleared axis label empty rather than defaulting it", () => {
    const doc = parseMaterialDoc(fence("past", "point 10 x"));
    expect((doc.blocks[0] as TimelineBlock).labels.past).toBe("");
    // The other two were absent, not cleared, so they still default.
    expect((doc.blocks[0] as TimelineBlock).labels.now).toBe("Now");
  });

  it("sorts markers left to right, whatever order they were written in", () => {
    const doc = parseMaterialDoc(fence("point 80 last", "point 10 first", "point 45 middle"));
    expect((doc.blocks[0] as TimelineBlock).points.map((p) => p.label)).toEqual([
      "first",
      "middle",
      "last",
    ]);
  });

  it("clamps an out-of-range position and rounds a fractional one", () => {
    const doc = parseMaterialDoc(fence("point 250 far", "span 12.4 12.6 tiny"));
    const block = doc.blocks[0] as TimelineBlock;
    expect(block.points).toEqual([{ at: 100, label: "far" }]);
    expect(block.span).toEqual({ from: 12, to: 13, label: "tiny" });
  });

  it("orders a backwards span's endpoints", () => {
    const doc = parseMaterialDoc(fence("span 60 20 backwards"));
    expect((doc.blocks[0] as TimelineBlock).span).toEqual({
      from: 20,
      to: 60,
      label: "backwards",
    });
  });

  it("accepts a marker with no label", () => {
    const doc = parseMaterialDoc(fence("point 30"));
    expect((doc.blocks[0] as TimelineBlock).points).toEqual([{ at: 30, label: "" }]);
  });

  it("accepts the language tag in any case", () => {
    const doc = parseMaterialDoc("```TimeLine\npoint 30 x\n```");
    expect(doc.blocks[0].type).toBe("timeline");
  });

  it("does not fold a timeline into an adjacent paragraph", () => {
    const doc = parseMaterialDoc(`Before\n${fence("point 30 x")}\nAfter`);
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "timeline", "paragraph"]);
  });

  it("nests inside a callout", () => {
    const doc = parseMaterialDoc(
      ["> [!grammar] Present perfect", ">", "> ```timeline", "> point 20 since 2020", "> ```"].join(
        "\n",
      ),
    );
    expect(doc.blocks).toEqual([
      {
        type: "callout",
        variant: "grammar",
        title: [{ type: "text", value: "Present perfect" }],
        blocks: [timeline({ points: [{ at: 20, label: "since 2020" }] })],
      },
    ]);
  });
});

describe("a timeline fence the parser will not read", () => {
  // Strictness is the whole point: half-drawing a payload, or silently dropping
  // the line it couldn't read, would lose content out of a document the teacher
  // is about to save over. It degrades to the code block it already parsed as.
  it.each([
    ["an unknown directive", fence("point 20 x", "wobble 3")],
    ["a mistyped position", fence("point twenty x")],
    ["a span missing an endpoint", fence("span 20")],
    ["no marker at all", fence("past Past", "now Now", "future Future")],
    ["an empty payload", "```timeline\n```"],
  ])("keeps %s as a code block", (_why, body) => {
    const block = parseMaterialDoc(body).blocks[0];
    expect(block.type).toBe("code");
    expect(block).toMatchObject({ lang: "timeline" });
  });

  it("round-trips the un-read payload verbatim, losing nothing", () => {
    const body = fence("point 20 x", "wobble 3");
    expect(serializeMaterialDoc(parseMaterialDoc(body))).toBe(body);
  });
});

describe("serializing a timeline", () => {
  it("emits a `timeline` fence with the axis labels first", () => {
    expect(serializeBlock(sample())).toBe(
      fence(
        "past Past",
        "now Now",
        "future Future",
        "span 20 50 have lived here",
        "point 20 I moved to Mérida",
      ),
    );
  });

  it("emits a bare directive for a cleared label", () => {
    const block = timeline({
      labels: { past: "", now: "", future: "" },
      points: [{ at: 5, label: "x" }],
    });
    expect(serializeBlock(block)).toBe(fence("past", "now", "future", "point 5 x"));
  });

  it("flattens a label that would otherwise break the payload onto one line", () => {
    const block = timeline({ points: [{ at: 5, label: "two\nlines" }] });
    const source = serializeBlock(block);
    expect(source).toBe(fence("past Past", "now Now", "future Future", "point 5 two lines"));
    expect(parseBlockText(source)).toEqual([timeline({ points: [{ at: 5, label: "two lines" }] })]);
  });
});

describe("the round-trip contract", () => {
  // The property the whole structural editor rests on: parse → serialize →
  // parse is a fixed point (see serialize.ts's header). A new block type is
  // exactly how it gets broken.
  const bodies = [
    fence("point 20 x"),
    fence("past Past", "now Now", "future Future", "span 20 50 have lived", "point 20 I moved"),
    fence("past", "now", "future", "point 0 start", "point 100 end"),
    fence("span 50 50 right now"),
    fence("point 80 later", "point 10 earlier"),
    fence("point 250 clamped", "span 12.4 12.6 rounded"),
    `# Present perfect\n\n${fence("point 20 since 2020")}\n\nWe use it for…`,
    `> [!grammar] Look\n>\n> \`\`\`timeline\n> point 20 x\n> \`\`\``,
    `- step one\n\n  \`\`\`timeline\n  point 20 x\n  \`\`\`\n\n- step two`,
    // Not a timeline — must stay a code block through the round trip too.
    fence("point 20 x", "nonsense"),
    "```js\nconst timeline = 1;\n```",
  ];

  it.each(bodies)("is a fixed point for %j", (body) => {
    const once = parseMaterialDoc(body);
    const twice = parseMaterialDoc(serializeMaterialDoc(once));
    expect(twice).toEqual(once);
  });

  it("is a fixed point for every prefix of a streamed payload", () => {
    const body = fence(
      "past Past",
      "now Now",
      "future Future",
      "span 20 50 have",
      "point 20 moved",
    );
    for (let i = 1; i <= body.length; i++) {
      const prefix = body.slice(0, i);
      const once = parseMaterialDoc(prefix);
      expect(parseMaterialDoc(serializeMaterialDoc(once))).toEqual(once);
    }
  });
});

describe("timeline block factories", () => {
  it("builds a starter timeline with a span and one marker", () => {
    const block = newTimelineBlock("have lived here", "I moved here") as TimelineBlock;
    expect(block).toEqual(
      timeline({
        span: { from: 20, to: TIMELINE_NOW, label: "have lived here" },
        points: [{ at: 20, label: "I moved here" }],
      }),
    );
  });

  it("produces a block that survives its own round trip", () => {
    const block = newTimelineBlock("", "") as MaterialBlock;
    expect(parseBlockText(serializeBlock(block))).toEqual([block]);
  });

  it("inserts into a block list like any other block", () => {
    const blocks: MaterialBlock[] = [{ type: "divider" }];
    const block = newTimelineBlock("span", "point");
    expect(block).not.toBeNull();
    expect(insertBlockAt(blocks, 0, block!)).toEqual([block, { type: "divider" }]);
  });
});

describe("the representability guard", () => {
  // A timeline with no marker at all reads back as a CODE block, so a teacher
  // who emptied one would find her diagram replaced by its own source on the
  // next save. The ops refuse rather than let that happen.
  it("recognises an empty axis as unrepresentable", () => {
    expect(isRepresentableTimeline(timeline())).toBe(false);
    expect(isRepresentableTimeline(sample())).toBe(true);
  });

  it("confirms the failure it is guarding against is real", () => {
    const empty = timeline();
    expect(parseBlockText(serializeBlock(empty))[0].type).toBe("code");
  });

  it("keeps the last marker when there is no span", () => {
    const block = timeline({ points: [{ at: 20, label: "only" }] });
    expect(removeTimelinePoint(block, 0)).toEqual(block);
  });

  it("removes the last marker when a span still carries the timeline", () => {
    const block = sample();
    expect(removeTimelinePoint(block, 0).points).toEqual([]);
  });

  it("keeps the span when it is the only thing on the timeline", () => {
    const block = timeline({ span: { from: 10, to: 40, label: "only" } });
    expect(clearTimelineSpan(block)).toEqual(block);
  });

  it("clears the span when a marker still carries the timeline", () => {
    expect(clearTimelineSpan(sample()).span).toBeNull();
  });
});

describe("timeline field setters", () => {
  it("retitles one axis label and allows clearing it", () => {
    expect(updateTimelineLabel(sample(), "now", "Hoy").labels.now).toBe("Hoy");
    expect(updateTimelineLabel(sample(), "future", "  ").labels.future).toBe("");
  });

  it("adds a marker, keeping the list in axis order", () => {
    const next = insertTimelinePoint(sample(), 5, "earlier");
    expect(next.points.map((p) => p.label)).toEqual(["earlier", "I moved to Mérida"]);
  });

  it("stops adding markers at the editor cap", () => {
    let block = timeline({ points: [{ at: 0, label: "0" }] });
    for (let i = 1; i < TIMELINE_MAX_POINTS + 3; i++) block = insertTimelinePoint(block, i, `${i}`);
    expect(block.points).toHaveLength(TIMELINE_MAX_POINTS);
  });

  it("moves a marker and re-sorts", () => {
    const block = timeline({
      points: [
        { at: 10, label: "a" },
        { at: 20, label: "b" },
      ],
    });
    expect(updateTimelinePointAt(block, 0, 90).points.map((p) => p.label)).toEqual(["b", "a"]);
  });

  it("clamps a moved marker onto the axis", () => {
    expect(updateTimelinePointAt(sample(), 0, -40).points[0].at).toBe(0);
  });

  it("relabels a marker and ignores an out-of-range index", () => {
    expect(updateTimelinePointLabel(sample(), 0, "moved away").points[0].label).toBe("moved away");
    expect(updateTimelinePointLabel(sample(), 7, "x")).toEqual(sample());
  });

  it("sets a span from endpoints given either way round", () => {
    expect(setTimelineSpan(sample(), 70, 30, "between")).toMatchObject({
      span: { from: 30, to: 70, label: "between" },
    });
  });

  it("relabels a span, and does nothing when there is none", () => {
    expect(updateTimelineSpanLabel(sample(), "since 2020").span?.label).toBe("since 2020");
    const bare = timeline({ points: [{ at: 5, label: "x" }] });
    expect(updateTimelineSpanLabel(bare, "x")).toEqual(bare);
  });

  it("defaults a new span from the first marker up to the present", () => {
    expect(defaultTimelineSpan(timeline({ points: [{ at: 15, label: "x" }] }))).toEqual({
      from: 15,
      to: TIMELINE_NOW,
    });
  });

  it("defaults a new span forwards when every marker is in the future", () => {
    const span = defaultTimelineSpan(timeline({ points: [{ at: 80, label: "x" }] }));
    expect(span.from).toBe(TIMELINE_NOW);
    expect(span.to).toBeGreaterThan(TIMELINE_NOW);
  });

  it("leaves every setter's result readable back as the same block", () => {
    const edited = updateTimelinePointAt(
      insertTimelinePoint(updateTimelineLabel(sample(), "past", "Antes"), 90, "later"),
      0,
      3,
    );
    expect(parseBlockText(serializeBlock(edited))).toEqual([edited]);
  });
});

describe("timeline geometry", () => {
  it("puts the present at the exact middle of the viewBox", () => {
    expect(timelineX(TIMELINE_NOW)).toBe(TIMELINE_VIEW_WIDTH / 2);
  });

  it("keeps every drawn element inside the bounded viewBox", () => {
    const block = timeline({
      span: { from: 0, to: 100, label: "all of it" },
      points: [
        { at: 0, label: "start" },
        { at: 100, label: "end" },
      ],
    });
    const geo = timelineGeometry(block);
    expect(geo.height).toBe(TIMELINE_VIEW_HEIGHT);
    expect(geo.span!.x).toBeGreaterThanOrEqual(0);
    expect(geo.span!.x + geo.span!.width).toBeLessThanOrEqual(TIMELINE_VIEW_WIDTH);
    for (const point of geo.points) {
      expect(point.cx - point.r).toBeGreaterThanOrEqual(0);
      expect(point.cx + point.r).toBeLessThanOrEqual(TIMELINE_VIEW_WIDTH);
      expect(point.cy).toBeLessThanOrEqual(TIMELINE_VIEW_HEIGHT);
    }
  });

  it("still draws a zero-width span", () => {
    const geo = timelineGeometry(timeline({ span: { from: 50, to: 50, label: "now" } }));
    expect(geo.span!.width).toBeGreaterThan(0);
  });

  it("omits the span when there is none", () => {
    expect(timelineGeometry(timeline({ points: [{ at: 5, label: "x" }] })).span).toBeNull();
  });
});

describe("text-only consumers", () => {
  it("keeps a timeline's labels in the homework excerpt", () => {
    const doc = parseMaterialDoc(
      [
        "> [!exercise] When did it happen?",
        ">",
        "> ```timeline",
        "> past Before",
        "> now Now",
        "> future After",
        "> span 20 50 have studied",
        "> point 20 started school",
        "> ```",
      ].join("\n"),
    );
    expect(extractHomeworkExcerptText(doc)).toBe(
      "[exercise] When did it happen?\nBefore · Now · After\nhave studied\nstarted school",
    );
  });

  it("contributes nothing for a timeline with no labels at all", () => {
    const doc = parseMaterialDoc(
      [
        "> [!homework] Draw it",
        ">",
        "> ```timeline",
        "> past",
        "> now",
        "> future",
        "> point 20",
        "> ```",
      ].join("\n"),
    );
    expect(extractHomeworkExcerptText(doc)).toBe("[homework] Draw it");
  });
});
