import React, { Fragment, type ReactNode } from "react";
import {
  Text,
  View,
  Link,
  Image,
  StyleSheet,
  Svg,
  Line,
  Polygon,
  Rect,
  Circle,
} from "@react-pdf/renderer";
import {
  calloutMeta,
  palette,
  resolveMaterialImageSrc,
  timelineGeometry,
  type CalloutVariant,
  type InlineNode,
  type ListItem,
  type MaterialBlock,
} from "@spiralclass/shared";

// The classic JSX transform (in effect under Vitest's esbuild default, vs.
// Next.js's own automatic-runtime SWC build) compiles JSX to
// `React.createElement` calls, so `React` must be in scope even though it's
// never referenced by name below.
void React;

// The PDF renderer for AI-generated class materials — the print sibling of the
// on-screen renderer (`components/materials/material-document.tsx`). Both walk
// the SAME canonical MaterialDoc tree (parsed once in @spiralclass/shared), so a
// downloaded PDF stays semantically in step with the on-screen preview without
// re-parsing Markdown here. Where the web renderer uses theme CSS variables and
// the display face, this one maps every block to @react-pdf/renderer primitives
// with the LIGHT brand palette (this document is always read on a light,
// legible background) and the built-in standard PDF fonts (Times for headings,
// Helvetica for body, Courier for code — no Font.register, no font files, no
// network).
//
// Security mirrors the web renderer: never emit raw HTML (the shared parser has
// no HTML sink), and every link href must pass the scheme allow-list below.
//
// TUNED FOR PHONE READING, not print: every material PDF is downloaded and
// opened in a phone browser — never
// printed or opened on a desktop. A react-pdf page is fixed-layout, not
// reflowable, so the one lever that actually changes legibility on a phone
// screen is the ratio of type size to page width: a phone PDF viewer opens at
// "fit to width," which scales the whole page uniformly, so bigger type and
// smaller margins both raise the effective on-screen size with no extra
// pinch-zoom needed. Sizes/spacing below are picked for that, not for a printed
// page.

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

/** Stored-image key → a URL react-pdf can fetch during rendering.
 *
 * Unlike the on-screen renderers, this one cannot use the authenticated image
 * route: the PDF is built server-side with no session of its own, so it would
 * be its own unauthenticated caller. The caller therefore pre-signs every key
 * the document references (see lib/pdf/material-images.ts) and passes the
 * result in. A key that's missing from the map renders as its caption — the
 * same graceful degradation as a disallowed src. */
export type MaterialPdfImages = Record<string, string>;

// Built-in standard PDF font family names (no registration needed).
const SERIF_BOLD = "Times-Bold";
const SERIF_ITALIC = "Times-Italic";
const SANS_BOLD = "Helvetica-Bold";
const SANS_ITALIC = "Helvetica-Oblique";
const MONO = "Courier";

/** Mix a brand hex over white at the given alpha, so callouts/code/zebra rows
 * get a subtle tint rather than a heavy ink-filled fill.
 * Returns an `rgb()` string @react-pdf understands. */
export function tint(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c: number) => Math.round(c * alpha + 255 * (1 - alpha));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// English callout labels for the PDF. The PDF has no i18n runtime context (it's
// a static export generated server-side), so we resolve the variant's default
// header text from this local table; an author-supplied inline `title` wins over
// it. Kept in the same order/meaning as the shared CALLOUT_META labelKeys.
export const CALLOUT_PDF_LABEL: Record<CalloutVariant, string> = {
  note: "Note",
  info: "Info",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  remember: "Remember",
  example: "Example",
  exercise: "Exercise",
  question: "Question",
  answer: "Answer",
  vocabulary: "Vocabulary",
  grammar: "Grammar",
  summary: "Summary",
  homework: "Homework",
};

const styles = StyleSheet.create({
  h1: {
    fontFamily: SERIF_BOLD,
    fontSize: 22,
    color: palette.text,
    marginTop: 18,
    marginBottom: 7,
    lineHeight: 1.25,
  },
  h2: {
    fontFamily: SERIF_BOLD,
    fontSize: 17,
    color: palette.text,
    marginTop: 16,
    marginBottom: 6,
    paddingBottom: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: palette.border,
    lineHeight: 1.3,
  },
  h3: {
    fontFamily: SERIF_BOLD,
    fontSize: 14,
    color: palette.text,
    marginTop: 14,
    marginBottom: 5,
    lineHeight: 1.3,
  },
  paragraph: { marginBottom: 10, lineHeight: 1.6 },
  listWrap: { marginBottom: 10 },
  listRow: { flexDirection: "row", marginBottom: 4 },
  listMarkerBullet: { color: palette.primary, width: 16 },
  listMarkerNumber: { fontFamily: SANS_BOLD, color: palette.primary, width: 20 },
  listMarkerCheck: { width: 18 },
  listBody: { flex: 1, lineHeight: 1.6 },
  listChildren: { marginTop: 4 },
  calloutWrap: {
    marginTop: 7,
    marginBottom: 12,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderLeftWidth: 3,
    borderRadius: 4,
  },
  calloutHeader: { fontFamily: SANS_BOLD, fontSize: 12, marginBottom: 5 },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: palette.accent,
    paddingLeft: 12,
    paddingVertical: 2,
    marginBottom: 12,
  },
  quoteText: { fontFamily: SERIF_ITALIC, color: palette.textMuted, lineHeight: 1.6 },
  codeBlock: {
    backgroundColor: tint(palette.muted, 0.7),
    padding: 10,
    marginBottom: 12,
    borderRadius: 4,
    fontFamily: MONO,
    fontSize: 11,
    color: palette.text,
    lineHeight: 1.55,
  },
  inlineCode: { fontFamily: MONO, backgroundColor: tint(palette.muted, 0.7), color: palette.text },
  strong: { fontFamily: SANS_BOLD },
  em: { fontFamily: SANS_ITALIC },
  link: { color: palette.primary, textDecoration: "underline" },
  table: {
    marginTop: 4,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: palette.border,
    borderRadius: 4,
  },
  tableRow: { flexDirection: "row" },
  tableHeaderCell: {
    flex: 1,
    padding: 6,
    borderWidth: 0.5,
    borderColor: palette.border,
    backgroundColor: palette.muted,
    fontFamily: SANS_BOLD,
    fontSize: 11,
    color: palette.text,
  },
  tableCell: {
    flex: 1,
    padding: 6,
    borderWidth: 0.5,
    borderColor: palette.border,
    fontSize: 11,
    lineHeight: 1.5,
  },
  divider: { borderTopWidth: 0.5, borderTopColor: palette.border, marginVertical: 14 },
  imageWrap: { marginTop: 6, marginBottom: 12, alignItems: "center" },
  // Bounded height, not width: a portrait photo at full page width would push
  // everything after it onto the next page. `objectFit: contain` keeps the
  // aspect ratio inside the box rather than distorting it.
  image: { maxWidth: "100%", maxHeight: 320, objectFit: "contain" },
  imageCaption: {
    fontSize: 10,
    color: palette.textMuted,
    marginTop: 4,
    textAlign: "center",
  },
  imageMissing: { fontFamily: SANS_ITALIC, fontSize: 11, color: palette.textMuted },
  timelineWrap: {
    marginTop: 6,
    marginBottom: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 0.5,
    borderColor: palette.border,
    borderRadius: 4,
  },
  // Fixed height, not an aspect-ratio box: this page is fixed-layout, so a
  // graphic that grew with its content would push the rest of a handout onto
  // the next page — the same reason the image block bounds height, not width.
  timelineSvg: { width: "100%", height: 62 },
  timelineAxisRow: { flexDirection: "row", marginTop: 2 },
  timelineAxisLabel: { flex: 1, fontSize: 9, color: palette.textMuted },
  timelineNowLabel: { flex: 1, fontSize: 9, fontFamily: SANS_BOLD, color: palette.text },
  timelineLegendRow: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  timelineLegendSwatch: { width: 14, marginRight: 6 },
  timelineLegendLabel: { flex: 1, fontSize: 10, color: palette.text, lineHeight: 1.4 },
});

// --- inline -----------------------------------------------------------------

export function renderInline(nodes: InlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case "text":
        return <Fragment key={key}>{node.value}</Fragment>;
      case "strong":
        return (
          <Text key={key} style={styles.strong}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "em":
        return (
          <Text key={key} style={styles.em}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "code":
        return (
          <Text key={key} style={styles.inlineCode}>
            {node.value}
          </Text>
        );
      case "link": {
        const inner = renderInline(node.children, key);
        // Only linkify safe schemes; otherwise render the text plainly, never a
        // clickable link (matches the on-screen renderer's allow-list).
        if (!SAFE_LINK.test(node.href.trim())) {
          return <Fragment key={key}>{inner}</Fragment>;
        }
        return (
          <Link key={key} src={node.href} style={styles.link}>
            {inner}
          </Link>
        );
      }
    }
  });
}

// --- blocks -----------------------------------------------------------------

function renderList(
  block: Extract<MaterialBlock, { type: "list" }>,
  key: string,
  images: MaterialPdfImages,
): ReactNode {
  return (
    <View key={key} style={styles.listWrap}>
      {block.items.map((item: ListItem, i) => {
        const rowKey = `${key}-li-${i}`;
        let marker: ReactNode;
        if (item.checked !== null) {
          marker = <Text style={styles.listMarkerCheck}>{item.checked ? "☑" : "☐"}</Text>;
        } else if (block.ordered) {
          marker = <Text style={styles.listMarkerNumber}>{`${i + 1}.`}</Text>;
        } else {
          marker = <Text style={styles.listMarkerBullet}>{"•"}</Text>;
        }
        return (
          <View key={rowKey} style={styles.listRow}>
            {marker}
            <View style={styles.listBody}>
              <Text style={item.checked === true ? { color: palette.textMuted } : undefined}>
                {renderInline(item.inlines, rowKey)}
              </Text>
              {item.children.length > 0 ? (
                <View style={styles.listChildren}>
                  {renderMaterialBlocks(item.children, rowKey, images)}
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function renderCallout(
  block: Extract<MaterialBlock, { type: "callout" }>,
  key: string,
  images: MaterialPdfImages,
): ReactNode {
  const role = calloutMeta(block.variant).role;
  const accent = palette[role];
  const label = block.title
    ? renderInline(block.title, `${key}-t`)
    : CALLOUT_PDF_LABEL[block.variant];
  return (
    <View
      key={key}
      style={[styles.calloutWrap, { backgroundColor: tint(accent, 0.08), borderLeftColor: accent }]}
    >
      <Text style={[styles.calloutHeader, { color: accent }]}>{label}</Text>
      {renderMaterialBlocks(block.blocks, key, images)}
    </View>
  );
}

function renderQuote(
  block: Extract<MaterialBlock, { type: "quote" }>,
  key: string,
  images: MaterialPdfImages,
): ReactNode {
  return (
    <View key={key} style={styles.quote}>
      <View style={styles.quoteText}>{renderMaterialBlocks(block.blocks, key, images)}</View>
    </View>
  );
}

function renderTable(block: Extract<MaterialBlock, { type: "table" }>, key: string): ReactNode {
  const colCount = block.header.length;
  return (
    <View key={key} style={styles.table}>
      <View style={styles.tableRow}>
        {block.header.map((cell, ci) => (
          <Text
            key={`${key}-h-${ci}`}
            style={[styles.tableHeaderCell, { textAlign: block.align[ci] ?? "left" }]}
          >
            {renderInline(cell, `${key}-h-${ci}`)}
          </Text>
        ))}
      </View>
      {block.rows.map((row, ri) => (
        <View key={`${key}-r-${ri}`} style={styles.tableRow}>
          {Array.from({ length: colCount }, (_, ci) => (
            <Text
              key={`${key}-r-${ri}-c-${ci}`}
              style={[
                styles.tableCell,
                { textAlign: block.align[ci] ?? "left" },
                ri % 2 === 1 ? { backgroundColor: tint(palette.muted, 0.4) } : {},
              ]}
            >
              {renderInline(row[ci] ?? [], `${key}-r-${ri}-c-${ci}`)}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function renderBlock(block: MaterialBlock, key: string, images: MaterialPdfImages): ReactNode {
  switch (block.type) {
    case "heading": {
      const style = block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
      // minPresenceAhead keeps a heading from orphaning at a page bottom — it
      // pushes to the next page unless ~40pt of its section follows.
      return (
        <Text key={key} style={style} minPresenceAhead={40}>
          {renderInline(block.inlines, key)}
        </Text>
      );
    }
    case "paragraph":
      return (
        <Text key={key} style={styles.paragraph}>
          {renderInline(block.inlines, key)}
        </Text>
      );
    case "list":
      return renderList(block, key, images);
    case "callout":
      return renderCallout(block, key, images);
    case "quote":
      return renderQuote(block, key, images);
    case "code":
      return (
        <Text key={key} style={styles.codeBlock}>
          {block.text}
        </Text>
      );
    case "table":
      return renderTable(block, key);
    case "image":
      return renderImage(block, key, images);
    case "timeline":
      return renderTimeline(block, key);
    case "divider":
      return <View key={key} style={styles.divider} />;
  }
}

/** An image, with its alt printed underneath as a caption.
 *
 * Three ways this degrades to caption-only text, all deliberate: a src outside
 * the allow-list, an external https image (react-pdf would have to fetch a
 * third-party host at render time — a slow, failure-prone dependency inside a
 * download request, and one that reports the server's IP to that host), and a
 * stored key the caller didn't pre-sign. In every case the alt still carries
 * the pedagogical content, which for a "describe this picture" exercise is the
 * exercise itself. */
function renderImage(
  block: Extract<MaterialBlock, { type: "image" }>,
  key: string,
  images: MaterialPdfImages,
): ReactNode {
  const ref = resolveMaterialImageSrc(block.src);
  const url = ref?.kind === "stored" ? images[ref.key] : undefined;

  if (!url) {
    return block.alt ? (
      <Text key={key} style={styles.imageMissing}>
        {block.alt}
      </Text>
    ) : null;
  }

  return (
    <View key={key} style={styles.imageWrap} wrap={false}>
      {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer's
          Image is not an <img> and takes no alt; the caption below carries the
          description into the exported file. */}
      <Image src={url} style={styles.image} />
      {block.alt ? <Text style={styles.imageCaption}>{block.alt}</Text> : null}
    </View>
  );
}

/** A tense timeline, drawn from the SHARED geometry — the same numbers the web
 * and mobile renderers use, so a downloaded handout matches the on-screen
 * material rather than being a second drawing of the same data.
 *
 * Two constraints this renderer has that the other two don't, both from the
 * doc's own "what each renderer can draw" table:
 *  - NO EMOJI. There is no `Font.register` here (built-in standard PDF fonts
 *    only), so every mark is a vector primitive — a Line, a Polygon arrow head,
 *    a Rect for the span, a Circle per marker. Nothing here needs a glyph the
 *    standard fonts don't carry.
 *  - FIXED LAYOUT. The graphic's height is pinned (styles.timelineSvg) and the
 *    whole figure is `wrap={false}`, so it can neither grow with its content
 *    nor split across a page break.
 *
 * Labels are real PDF text below the graphic rather than SVG `<Text>`, for the
 * same reason as on the other two surfaces (see material-document.tsx): no
 * renderer can measure a string, so on-axis captions would collide or overflow
 * with no way to detect it. The legend runs in axis order, left to right. */
function renderTimeline(
  block: Extract<MaterialBlock, { type: "timeline" }>,
  key: string,
): ReactNode {
  const geo = timelineGeometry(block);
  const legend = [
    ...(block.span?.label ? [{ kind: "span" as const, label: block.span.label }] : []),
    ...block.points.filter((p) => p.label).map((p) => ({ kind: "point" as const, label: p.label })),
  ];

  return (
    <View key={key} style={styles.timelineWrap} wrap={false}>
      <Svg viewBox={`0 0 ${geo.width} ${geo.height}`} style={styles.timelineSvg}>
        {geo.span ? (
          <Rect
            x={geo.span.x}
            y={geo.span.y}
            width={geo.span.width}
            height={geo.span.height}
            rx={geo.span.radius}
            ry={geo.span.radius}
            fill={tint(palette.primary, 0.25)}
            stroke={palette.primary}
            strokeWidth={1}
          />
        ) : null}
        <Line
          x1={geo.axis.x1}
          y1={geo.axis.y1}
          x2={geo.axis.x2}
          y2={geo.axis.y2}
          stroke={palette.textMuted}
          strokeWidth={1.5}
        />
        <Polygon points={geo.arrow} fill={palette.textMuted} />
        <Line
          x1={geo.now.x}
          y1={geo.now.y1}
          x2={geo.now.x}
          y2={geo.now.y2}
          stroke={palette.accent}
          strokeWidth={2.5}
        />
        {geo.points.map((point, i) => (
          <Circle
            key={`${key}-p-${i}`}
            cx={point.cx}
            cy={point.cy}
            r={point.r}
            fill={palette.primary}
            stroke={palette.surface}
            strokeWidth={1.5}
          />
        ))}
      </Svg>
      <View style={styles.timelineAxisRow}>
        <Text style={[styles.timelineAxisLabel, { textAlign: "left" }]}>{block.labels.past}</Text>
        <Text style={[styles.timelineNowLabel, { textAlign: "center" }]}>{block.labels.now}</Text>
        <Text style={[styles.timelineAxisLabel, { textAlign: "right" }]}>
          {block.labels.future}
        </Text>
      </View>
      {legend.map((entry, i) => (
        <View key={`${key}-l-${i}`} style={styles.timelineLegendRow}>
          <View style={styles.timelineLegendSwatch}>
            <View
              style={
                entry.kind === "span"
                  ? {
                      width: 14,
                      height: 5,
                      borderRadius: 2.5,
                      backgroundColor: tint(palette.primary, 0.25),
                      borderWidth: 0.5,
                      borderColor: palette.primary,
                    }
                  : {
                      width: 5,
                      height: 5,
                      borderRadius: 2.5,
                      marginLeft: 4.5,
                      backgroundColor: palette.primary,
                    }
              }
            />
          </View>
          <Text style={styles.timelineLegendLabel}>{entry.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** Map a parsed MaterialDoc block list to @react-pdf/renderer elements.
 *
 * `images` resolves each stored image key to a URL react-pdf can actually
 * fetch. It is threaded explicitly rather than read from module state because
 * a PDF render is not the only thing running in the process — a request-scoped
 * global would be a cross-request leak waiting to happen. */
export function renderMaterialBlocks(
  blocks: MaterialBlock[],
  keyPrefix = "b",
  images: MaterialPdfImages = {},
): ReactNode[] {
  return blocks.map((block, i) => renderBlock(block, `${keyPrefix}-${i}`, images));
}
