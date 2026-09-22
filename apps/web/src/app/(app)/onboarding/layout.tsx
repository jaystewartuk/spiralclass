import { requireTeacher } from "@/lib/auth";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { AccountBadge } from "@/components/account-badge";
import { SignOutButton } from "@/components/sign-out-button";
import { getT } from "@/lib/i18n";
import { OnboardingStepper, OnboardingBack } from "./stepper";

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const teacher = await requireTeacher();
  const t = await getT();
  return (
    <main className="container py-10 lg:max-w-2xl">
      {/* Onboarding hides the app nav, so this is the only place a teacher
          can confirm which account they signed up with — and bail to the
          right one if it's wrong. */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <AccountBadge email={teacher.email} name={teacher.name} />
        <SignOutButton label={t("common.signOut")} />
      </div>
      <div className="mb-8 flex justify-center">
        <Link href="/dashboard" aria-label="SpiralClass">
          <Logo size="md" />
        </Link>
      </div>
      <OnboardingStepper />
      {children}
      <OnboardingBack />
    </main>
  );
}
