import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { getMarketingProfile } from "@/lib/marketing/profile";
import { SectionNav } from "../section-nav";
import { MarketingProfileForm } from "./profile-form";

export default async function MarketingProfilePage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();
  const profile = await getMarketingProfile(teacher.id);

  return (
    <PageShell width="reading">
      <SectionNav current="profile" />
      <PageHeader
        title={t("web.getStudents.profileTitle")}
        description={t("web.getStudents.profileSubtitle")}
      />
      <MarketingProfileForm values={profile} />
    </PageShell>
  );
}
