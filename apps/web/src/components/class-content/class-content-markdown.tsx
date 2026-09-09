import { MaterialDocument } from "@/components/materials/material-document";

// Backwards-compatible adapter. Every material render surface on the web (the
// teacher preview, the student class view, the in-call viewer, the library
// list) imports `ClassContentMarkdown`; it now delegates to the shared
// MaterialDocument renderer (docs: the material-rendering redesign) so all of
// them get the premium document design system — semantic callouts, brand
// typography, styled tables/lists — from one implementation. The sanitisation
// boundary is unchanged: the parser has no HTML sink and never evaluates raw
// markup (D-17). Kept as a named export so no call site had to change.
export function ClassContentMarkdown({
  body,
  readingWidth,
}: {
  body: string;
  readingWidth?: boolean;
}) {
  return <MaterialDocument body={body} readingWidth={readingWidth} />;
}
