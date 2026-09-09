import React from "react";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { hasAnswerKey, parseMaterialDoc, palette, stripAnswerKey } from "@spiralclass/shared";
import { renderMaterialBlocks } from "./material-doc-pdf";
import { signMaterialImages } from "./material-images";

// The classic JSX transform (in effect under Vitest's esbuild default, vs.
// Next.js's own automatic-runtime SWC build) compiles JSX to
// `React.createElement` calls, so `React` must be in scope even though it's
// never referenced by name below.
void React;

// Renders a native ("content") library material — title + Markdown body — as a
// professionally-published PDF (materials PDF export). File and link materials
// already have a downloadable/viewable URL; this is the one material kind with
// no artifact to download.
//
// THE STUDENT COPY IS THE DEFAULT. `[!answer]` callouts are the answer key —
// the generation prompt puts solutions there precisely so they can be withheld,
// and on screen the renderers collapse them behind "Show answer". A PDF has no
// toggle, so this export cuts them out of the tree instead (stripAnswerKey) and
// only keeps them when the caller explicitly asks via `includeAnswerKey`. The
// default matters: this same route backs the link a STUDENT clicks on their own
// class page, and a leaked answer key is not recoverable once the file is on
// their phone.
//
// The body is parsed ONCE via the shared parser (@spiralclass/shared) into the
// canonical MaterialDoc tree — the SAME tree the on-screen renderer consumes —
// then mapped to @react-pdf/renderer primitives by `renderMaterialBlocks`. No
// unified/remark in this path. Fonts are the built-in standard PDF families
// (Times for the cover title/headings, Helvetica for body, Courier for code),
// so nothing needs registering and no network/font-file access is required.
//
// Layout: a title/cover band on page 1 (large Times-Bold title + optional meta
// + an accent rule), a fixed running footer on every page (brand wordmark left,
// page number right) and a fixed running header on pages 2+ (small title + a
// hairline), so the document reads like a published handout.
//
// TUNED FOR PHONE READING: every material PDF is downloaded and opened on a
// phone browser — never printed or
// opened on a desktop — so the margins are trimmed and the type sized up from
// what a print-oriented A4 document would use (see material-doc-pdf.tsx for the
// full "why": a fixed-layout PDF viewer fits the page to the screen width, so
// less margin + bigger type is what actually reads bigger, without any extra
// pinch-zoom).

const SERIF_BOLD = "Times-Bold";

// The footer wordmark. It is the brand name — a proper noun, identical in every
// locale (the catalog's `common.brandName` is the same string in es-MX/en/fr) —
// and the PDF is generated server-side with no i18n runtime, so it is a plain
// constant rather than catalog-routed copy. Held here (not inline JSX text) so
// it reads as an intentional non-translatable brand mark.
const WORDMARK = "SpiralClass";

// The cover stamp on a teacher copy. Same reasoning as CALLOUT_PDF_LABEL in
// material-doc-pdf.tsx: the PDF is generated server-side with no i18n runtime,
// so its chrome is English. It earns its place — the two exports of one
// material differ only in blocks buried somewhere inside, and the teacher must
// be able to tell at a glance which file she is about to send a student.
const ANSWER_KEY_STAMP = "Teacher copy · includes answer key";

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 34,
    paddingHorizontal: 26,
    fontSize: 13,
    fontFamily: "Helvetica",
    color: palette.text,
    lineHeight: 1.6,
  },
  // Cover / title band (page 1 only).
  cover: { marginBottom: 16 },
  coverTitle: { fontFamily: SERIF_BOLD, fontSize: 23, color: palette.text, lineHeight: 1.15 },
  coverMeta: { fontSize: 11, color: palette.textMuted, marginTop: 6 },
  coverStamp: { fontSize: 11, color: palette.danger, marginTop: 6 },
  coverRule: { marginTop: 10, borderTopWidth: 2, borderTopColor: palette.primary, width: 64 },
  // Fixed running header (pages 2+).
  runningHeader: {
    position: "absolute",
    top: 16,
    left: 26,
    right: 26,
  },
  runningHeaderText: { fontSize: 9, color: palette.textSubtle },
  runningHeaderRule: { marginTop: 4, borderTopWidth: 0.5, borderTopColor: palette.border },
  // Fixed running footer (every page).
  footer: {
    position: "absolute",
    bottom: 18,
    left: 26,
    right: 26,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 9, color: palette.textSubtle },
});

export type MaterialPdfInput = {
  title: string;
  body: string;
  metaLine?: string | null;
  /** Keep the `[!answer]` callouts. Omitted/false renders the student copy —
   * see the header. Only a teacher-authenticated caller may set it. */
  includeAnswerKey?: boolean;
};

export async function renderMaterialPdfBuffer(input: MaterialPdfInput): Promise<Buffer> {
  const parsed = parseMaterialDoc(input.body);
  const withAnswerKey = input.includeAnswerKey === true;
  const doc = withAnswerKey ? parsed : stripAnswerKey(parsed);
  // Stamp only when there is really an answer key in the file — on a material
  // with no `[!answer]` blocks the two exports are identical, and a stamp
  // promising answers that aren't there is just wrong.
  const stamped = withAnswerKey && hasAnswerKey(parsed);
  // Signed AFTER the answer key is stripped, so a student copy never mints a
  // URL for a picture that only appears inside an `[!answer]` block.
  const images = await signMaterialImages(doc);
  const pdf = (
    <Document title={input.title}>
      <Page size="A4" style={styles.page}>
        {/* Running header — fixed on every page, hidden on page 1 via render. */}
        <View style={styles.runningHeader} fixed>
          <Text
            style={styles.runningHeaderText}
            render={({ pageNumber }) => (pageNumber > 1 ? input.title : "")}
          />
          <Text
            style={styles.runningHeaderRule}
            render={({ pageNumber }) => (pageNumber > 1 ? " " : "")}
          />
        </View>

        {/* Running footer — wordmark left, page number right, every page. */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{WORDMARK}</Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
          />
        </View>

        {/* Cover / title band — page 1 header, not a separate blank page. */}
        <View style={styles.cover}>
          <Text style={styles.coverTitle}>{input.title}</Text>
          {input.metaLine ? <Text style={styles.coverMeta}>{input.metaLine}</Text> : null}
          {stamped ? <Text style={styles.coverStamp}>{ANSWER_KEY_STAMP}</Text> : null}
          <View style={styles.coverRule} />
        </View>

        <View>{renderMaterialBlocks(doc.blocks, "b", images)}</View>
      </Page>
    </Document>
  );
  return renderToBuffer(pdf);
}
