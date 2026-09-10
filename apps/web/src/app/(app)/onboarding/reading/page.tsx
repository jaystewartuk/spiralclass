import Link from "next/link";
import { requireTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { getReadingPreferences } from "@/lib/reading-server";
import { ReadingControls } from "@/components/reading-controls";
import { Button } from "@/components/ui/button";

/**
 * The first onboarding step: how do you like to read? (D-140)
 *
 * It is here rather than only in settings because discovery is the hard part.
 * The people these controls help most are the least likely to go hunting
 * through an account page for them, and a permanent toolbar would tax every
 * screen forever to serve some readers. An onboarding step is seen by everyone
 * exactly once, costs nothing afterwards, and normalises the setting instead of
 * filing it under accessibility.
 *
 * It runs FIRST, before timezone, for a plain reason: every screen after this
 * one is easier to read once it is set.
 */
export default async function OnboardingReadingPage() {
  await requireTeacher();
  const t = await getT();
  const reading = await getReadingPreferences();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">{t("web.onboarding.reading.heading")}</h1>
        <p className="text-muted-foreground max-w-prose">{t("web.onboarding.reading.intro")}</p>
      </div>

      <ReadingControls initial={reading} />

      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link href="/onboarding/timezone">{t("web.onboarding.reading.continue")}</Link>
        </Button>
        <span className="text-muted-foreground text-sm">
          {t("web.onboarding.reading.changeLater")}
        </span>
      </div>
    </div>
  );
}
