"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";

// "Save as PDF" = the browser's own print-to-PDF. This keeps PDF as a
// downstream export of the native content (D-17), never the source of truth,
// with zero PDF-generation dependency. Shared by the student and teacher
// print pages. Hidden from the printed output itself.
export function PrintButton() {
  const t = useT();
  return (
    <Button type="button" onClick={() => window.print()} className="print:hidden">
      {t("web.printButton.saveAsPdf")}
    </Button>
  );
}
