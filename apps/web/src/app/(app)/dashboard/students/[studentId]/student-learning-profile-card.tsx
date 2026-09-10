import type { InsightCategory } from "@prisma/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { profileSchema, type StudentProfile, type Trend } from "@/lib/lesson-notes/profile";
import { skillLabel } from "@/lib/lesson-notes/skills";
import type { TFunction, StringKey } from "@/lib/i18n-translate";
import { ShareProgressToggle } from "./share-progress-toggle";
import { InsightsConsentControl } from "./insights-consent-control";

// Phase E read view: the per-student
// learning profile — recurring focus areas (by recurrence + trend) and the
// vocabulary queue. Server component; the JSON is Zod-validated so a malformed
// row degrades to "no profile" rather than crashing the page.
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

type FocusRow = {
  category: string;
  skill: string;
  recurrenceCount: number;
  trend: Trend;
  lastEvidence: string | null;
};

function flattenFocus(profile: StudentProfile): FocusRow[] {
  const rows: FocusRow[] = [];
  for (const [category, skills] of Object.entries(profile.byCategory)) {
    for (const [skill, entry] of Object.entries(skills)) {
      rows.push({
        category,
        skill,
        recurrenceCount: entry.recurrenceCount,
        trend: entry.trend,
        lastEvidence: entry.lastEvidence,
      });
    }
  }
  // Most recurrent first; "focus" trend bubbles up on ties.
  const trendRank: Record<Trend, number> = { focus: 0, new: 1, improving: 2 };
  return rows.sort(
    (a, b) => b.recurrenceCount - a.recurrenceCount || trendRank[a.trend] - trendRank[b.trend],
  );
}

function catLabel(t: TFunction, category: string): string {
  const key = CATEGORY_KEY[category as InsightCategory];
  return key ? t(key) : category;
}

export function StudentLearningProfileCard({
  profile: raw,
  studentId,
  shareProgress,
  insightsConsented,
  isMinor,
  captionsGuardianConsented,
  t,
}: {
  profile: unknown;
  studentId: string;
  shareProgress: boolean;
  insightsConsented: boolean;
  isMinor: boolean;
  captionsGuardianConsented: boolean;
  t: TFunction;
}) {
  const parsed = raw ? profileSchema.safeParse(raw) : null;
  const profile = parsed?.success ? parsed.data : null;
  const focus = profile ? flattenFocus(profile) : [];
  const vocab = profile?.vocabulary ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg" as="h2">
          {t("web.studentProfile.title")}
        </CardTitle>
        <CardDescription>{t("web.studentProfile.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {focus.length === 0 && vocab.length === 0 ? (
          <p className="text-muted-foreground">{t("web.studentProfile.empty")}</p>
        ) : (
          <>
            {focus.length > 0 && (
              <ul className="space-y-2">
                {focus.map((f) => (
                  <li
                    key={`${f.category}-${f.skill}`}
                    className="flex items-start justify-between gap-3 border-l-2 border-muted pl-3"
                  >
                    <div>
                      <p className="font-medium">
                        {skillLabel(t, f.skill)}{" "}
                        <span className="font-normal text-muted-foreground">
                          · {catLabel(t, f.category)}
                        </span>
                      </p>
                      {f.lastEvidence && (
                        <p className="text-muted-foreground">“{f.lastEvidence}”</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant={TREND_KEY[f.trend].variant}>
                        {t(TREND_KEY[f.trend].key)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">×{f.recurrenceCount}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {vocab.length > 0 && (
              <div className="space-y-1">
                <h4 className="text-sm font-medium text-muted-foreground">
                  {t("web.studentProfile.vocabTitle")}
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {vocab.map((v) => (
                    <Badge key={v.term} variant="outline">
                      {v.term}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <div className="border-t pt-3">
          <InsightsConsentControl
            studentId={studentId}
            consented={insightsConsented}
            isMinor={isMinor}
            captionsGuardianConsented={captionsGuardianConsented}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t("web.studentProfile.consentNote")}
          </p>
        </div>

        <div className="border-t pt-3">
          <ShareProgressToggle studentId={studentId} shared={shareProgress} />
          <p className="mt-1 text-xs text-muted-foreground">{t("web.studentProfile.shareNote")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
