import { Button } from "@/components/ui/button";
import { getT } from "@/lib/i18n";

// The "Download my data" pieces for the account pages. The /api/account/export
// endpoint resolves the caller (student or teacher) from the session, so one
// button serves both — the only difference is the parenthetical list of what's
// included, which is role-aware.

/** The role-aware "what's in the file" sentence, for a caller that renders its
 * own heading. */
export async function dataExportDescription(role: "student" | "teacher") {
  const t = await getT();
  const included =
    role === "teacher"
      ? t("web.dataExportCard.includedTeacher")
      : t("web.dataExportCard.includedStudent");
  return t("web.dataExportCard.description", { included });
}

/** The download control alone.
 *
 * `<Button asChild>` rather than an `<a>` carrying a hand-copied approximation
 * of the button's classes: the copy had drifted to `h-9`, under the 44px touch
 * target D-140 sets, and carried no focus ring at all. */
export async function DataExportButton() {
  const t = await getT();
  return (
    <Button asChild variant="outline">
      <a href="/api/account/export" download>
        {t("web.dataExportCard.downloadButton")}
      </a>
    </Button>
  );
}
