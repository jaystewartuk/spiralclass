import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Trend } from "@/lib/lesson-notes/profile";
import { buildProfileView, type ProfileRow } from "@/lib/lesson-notes/profile-view";
import { skillLabel } from "@/lib/lesson-notes/skills";
import type { TFunction, StringKey } from "@/lib/i18n-translate";
import { ShareProgressToggle } from "./share-progress-toggle";
import { InsightsConsentControl } from "./insights-consent-control";
import { AddFocusForm } from "./add-focus-form";

// The teacher's learning profile: how the student speaks (fluency and
// comprehension), what to work on, and the vocabulary queue. Server component;
// what to show and in what order is decided in lib/lesson-notes/profile-view.ts
// (Zod-validated, so a malformed row degrades to "no profile").
//
// Deliberately no timestamps and no full quotes: a teacher reading across a
// student's history wants the pattern. The last example is a short, collapsed
// hint for the moments she wants to jog her memory.
//
// SYNCHRONOUS, and takes `t` from its caller. It used to await `getT()` itself,
// which made every parent that rendered it async too — including the page,
// which then could not be rendered in one pass by anything that is not.

const CATEGORY_KEY: Record<string, StringKey> = {
  pronunciation: "web.studentProfile.category.pronunciation",
  grammar: "web.studentProfile.category.grammar",
  vocabulary: "web.studentProfile.category.vocabulary",
  fluency: "web.studentProfile.category.fluency",
  comprehension: "web.studentProfile.category.comprehension",
};

const TREND_KEY: Record<Trend, { key: StringKey; variant: "default" | "secondary" | "outline" }> = {
  focus: { key: "web.studentProfile.trend.focus", variant: "default" },
  improving: { key: "web.studentProfile.trend.improving", variant: "secondary" },
  new: { key: "web.studentProfile.trend.new", variant: "outline" },
};

function catLabel(t: TFunction, category: string): string {
  const key = CATEGORY_KEY[category];
  return key ? t(key) : category;
}

function RowList({ rows, t }: { rows: ProfileRow[]; t: TFunction }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={`${r.category}-${r.skill}`} className="border-l-2 border-muted pl-3">
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium">
              {skillLabel(t, r.skill)}{" "}
              <span className="font-normal text-muted-foreground">· {catLabel(t, r.category)}</span>
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={TREND_KEY[r.trend].variant}>{t(TREND_KEY[r.trend].key)}</Badge>
              <span className="text-xs text-muted-foreground">×{r.recurrenceCount}</span>
            </div>
          </div>
          {r.hint && (
            <details className="mt-1 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">
                {t("web.studentProfile.hintToggle")}
              </summary>
              <p className="mt-1">“{r.hint}”</p>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

export function StudentLearningProfileCard({
  profile: raw,
  studentId,
  shareProgress,
  insightsConsented,
  isMinor,
  captionsGuardianConsented,
  captionsSelfConsented,
  addToBookingId,
  t,
}: {
  profile: unknown;
  studentId: string;
  shareProgress: boolean;
  insightsConsented: boolean;
  isMinor: boolean;
  captionsGuardianConsented: boolean;
  captionsSelfConsented: boolean;
  /** The class a teacher-added focus area attaches to; null before any class exists. */
  addToBookingId: string | null;
  t: TFunction;
}) {
  const { signals, focus, vocabulary } = buildProfileView(raw);
  const empty = signals.length === 0 && focus.length === 0 && vocabulary.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg" as="h2">
          {t("web.studentProfile.title")}
        </CardTitle>
        <CardDescription>{t("web.studentProfile.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {empty ? (
          <p className="text-muted-foreground">{t("web.studentProfile.empty")}</p>
        ) : (
          <>
            {signals.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-medium">{t("web.studentProfile.signalsTitle")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("web.studentProfile.signalsDescription")}
                </p>
                <RowList rows={signals} t={t} />
              </section>
            )}

            {focus.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-medium">{t("web.studentProfile.focusTitle")}</h3>
                <RowList rows={focus} t={t} />
              </section>
            )}

            {vocabulary.length > 0 && (
              <section className="space-y-1">
                <h3 className="font-medium">{t("web.studentProfile.vocabTitle")}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {vocabulary.map((term) => (
                    <Badge key={term} variant="outline">
                      {term}
                    </Badge>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        <div className="border-t pt-4">
          {addToBookingId ? (
            <AddFocusForm bookingId={addToBookingId} />
          ) : (
            <p className="text-xs text-muted-foreground">{t("web.studentProfile.addNoClass")}</p>
          )}
        </div>

        <div className="border-t pt-3">
          <InsightsConsentControl
            studentId={studentId}
            consented={insightsConsented}
            isMinor={isMinor}
            captionsGuardianConsented={captionsGuardianConsented}
            captionsSelfConsented={captionsSelfConsented}
          />
        </div>

        <div className="border-t pt-3">
          <ShareProgressToggle studentId={studentId} shared={shareProgress} />
          <p className="mt-1 text-xs text-muted-foreground">{t("web.studentProfile.shareNote")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
