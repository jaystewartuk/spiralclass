import { describe, expect, it } from "vitest";

import {
  insertBlockAt,
  newImageBlock,
  updateImageAlt,
  updateImageSrc,
  type ImageBlock,
} from "./block-editor";
import { extractHomeworkExcerptText, parseBlockText, parseMaterialDoc } from "./parse";
import { serializeBlock, serializeMaterialDoc } from "./serialize";
import type { MaterialBlock } from "./types";

const SRC = "material-image:t/library/images/1712-abc.png";

function imageBlock(alt = "A market stall", src = SRC): ImageBlock {
  return { type: "image", src, alt };
}

describe("parsing a standalone image", () => {
  it("reads `![alt](src)` alone on a line as an image block", () => {
    expect(parseMaterialDoc(`![A market stall](${SRC})`).blocks).toEqual([imageBlock()]);
  });

  it("accepts an empty alt", () => {
    expect(parseMaterialDoc(`![](${SRC})`).blocks).toEqual([imageBlock("")]);
  });

  it("trims surrounding whitespace on the line and in the alt", () => {
    expect(parseMaterialDoc(`   ![  spaced  ](${SRC})   `).blocks).toEqual([imageBlock("spaced")]);
  });

  it("carries an external https src verbatim", () => {
    const doc = parseMaterialDoc("![cat](https://cdn.example.com/cat.png)");
    expect(doc.blocks).toEqual([imageBlock("cat", "https://cdn.example.com/cat.png")]);
  });

  // The src allow-list lives in the renderers, not the parser — the parser's
  // job is to produce the node so the block round-trips; the sink decides
  // whether to load it. Mirrors how link hrefs are handled.
  it("parses an unsafe src rather than dropping the block", () => {
    const doc = parseMaterialDoc("![x](javascript:whatever)");
    expect(doc.blocks).toEqual([imageBlock("x", "javascript:whatever")]);
  });

  // `[^)\s]+` cannot span a `)`, so a src containing one never forms an image
  // at all — it degrades to a paragraph rather than truncating mid-src.
  it("degrades a src containing parens to a paragraph", () => {
    expect(parseMaterialDoc("![x](javascript:alert(1))").blocks[0].type).toBe("paragraph");
  });

  // MaterialBlock has no inline image, so an image inside a sentence must not
  // silently become a block — it stays literal text.
  it("leaves an image mid-sentence as paragraph text", () => {
    const doc = parseMaterialDoc(`Look at this ![alt](${SRC}) picture.`);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].type).toBe("paragraph");
  });

  it("does not fold an image into an adjacent paragraph", () => {
    const doc = parseMaterialDoc(`Before the picture\n![alt](${SRC})\nAfter the picture`);
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "image", "paragraph"]);
  });

  it("nests inside a callout", () => {
    const doc = parseMaterialDoc(`> [!vocabulary] Fruit\n>\n> ![an apple](${SRC})`);
    expect(doc.blocks).toEqual([
      {
        type: "callout",
        variant: "vocabulary",
        title: [{ type: "text", value: "Fruit" }],
        blocks: [imageBlock("an apple")],
      },
    ]);
  });
});

describe("serializing an image", () => {
  it("emits `![alt](src)`", () => {
    expect(serializeBlock(imageBlock())).toBe(`![A market stall](${SRC})`);
  });

  it("sanitizes an alt that would break the block's own spelling", () => {
    const block: ImageBlock = { type: "image", src: SRC, alt: "a [bad] alt\nwrapped" };
    const source = serializeBlock(block);
    expect(source).toBe(`![a bad alt wrapped](${SRC})`);
    expect(parseBlockText(source)).toEqual([{ type: "image", src: SRC, alt: "a bad alt wrapped" }]);
  });

  it("sanitizes a src containing spaces or parens", () => {
    const block: ImageBlock = { type: "image", src: "https://x/a (1).png", alt: "" };
    expect(serializeBlock(block)).toBe("![](https://x/a1.png)");
  });
});

describe("the round-trip contract", () => {
  // The property the whole editor rests on: parse → serialize → parse is a
  // fixed point (see serialize.ts's header).
  const bodies = [
    `![alt](${SRC})`,
    `# Lesson\n\n![A market stall](${SRC})\n\nBuy some fruit.`,
    `> [!example] Describe it\n>\n> ![a busy street](${SRC})`,
    `- step one\n\n  ![detail](${SRC})\n\n- step two`,
    `![](${SRC})`,
    "![external](https://cdn.example.com/a.png)",
    `Before\n\n![alt](${SRC})\n\nAfter`,
  ];

  it.each(bodies)("is a fixed point for %j", (body) => {
    const once = parseMaterialDoc(body);
    const twice = parseMaterialDoc(serializeMaterialDoc(once));
    expect(twice).toEqual(once);
  });

  // A paragraph whose text genuinely begins with image syntax must survive
  // too — that's what the `!` added to PARA_ESCAPABLE is for.
  it("keeps a paragraph that merely looks like an image a paragraph", () => {
    const doc = parseMaterialDoc("Type this: ![alt](src)");
    const round = parseMaterialDoc(serializeMaterialDoc(doc));
    expect(round).toEqual(doc);
    expect(round.blocks[0].type).toBe("paragraph");
  });
});

describe("image block factories", () => {
  it("builds a block and sanitizes both fields", () => {
    expect(newImageBlock(` ${SRC} `, "  a [caption]  ")).toEqual(imageBlock("a caption"));
  });

  // An image with no src has no representable Markdown form and would vanish
  // on the next round trip, so the factory refuses rather than emitting one.
  it.each(["", "   ", "()"])("refuses an unusable src %j", (src) => {
    expect(newImageBlock(src, "alt")).toBeNull();
  });

  it("retitles without touching the src", () => {
    expect(updateImageAlt(imageBlock(), "A fruit stall")).toEqual(imageBlock("A fruit stall"));
  });

  it("allows clearing the alt", () => {
    expect(updateImageAlt(imageBlock(), "   ")).toEqual(imageBlock(""));
  });

  it("repoints the src", () => {
    const next = updateImageSrc(imageBlock(), "https://cdn.example.com/b.png");
    expect(next.src).toBe("https://cdn.example.com/b.png");
    expect(next.alt).toBe("A market stall");
  });

  it("leaves the block untouched when the new src is unusable", () => {
    const block = imageBlock();
    expect(updateImageSrc(block, "  ")).toEqual(block);
  });

  it("inserts into a block list like any other block", () => {
    const blocks: MaterialBlock[] = [{ type: "divider" }];
    const image = newImageBlock(SRC, "alt");
    expect(image).not.toBeNull();
    expect(insertBlockAt(blocks, 0, image!)).toEqual([image, { type: "divider" }]);
  });
});

describe("text-only consumers", () => {
  // A "describe this picture" exercise is entirely carried by its alt text —
  // dropping it would hand the homework-review prompt a question with no
  // question in it.
  it("keeps an image's alt in the homework excerpt", () => {
    const doc = parseMaterialDoc(
      `> [!homework] Homework\n>\n> ![Describe this market scene](${SRC})\n>\n> Write 100 words.`,
    );
    expect(extractHomeworkExcerptText(doc)).toBe(
      "[homework] Homework\nDescribe this market scene\nWrite 100 words.",
    );
  });

  it("contributes nothing for an image with no alt", () => {
    const doc = parseMaterialDoc(`> [!homework] Homework\n>\n> ![](${SRC})\n>\n> Write.`);
    expect(extractHomeworkExcerptText(doc)).toBe("[homework] Homework\nWrite.");
  });
});
