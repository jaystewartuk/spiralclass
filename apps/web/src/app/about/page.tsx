import { Heading } from "@/components/ui/heading";
import { PageShell } from "@/components/ui/page-shell";
import { PersonAvatar } from "@/components/teacher-identity";
import Link from "next/link";
import type { Metadata } from "next";
import { Code2, GraduationCap, Globe, Heart, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { SOURCE_CODE_LICENCE, SOURCE_CODE_URL } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { StringKey } from "@/lib/i18n-translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("web.about.meta.title"),
    description: t("web.about.meta.description"),
    alternates: { canonical: "/about" },
  };
}

const FOUNDERS: Array<{
  photo: string;
  nameEs: string;
  nameEn: string;
  roleKey: StringKey;
  bioKey: StringKey;
}> = [
  {
    // No photograph is committed here — a real person's photograph is not
    // something a public repository should carry, and the card falls back to
    // a monogram. Set a URL if a deployment wants one.
    photo: "",
    nameEs: "Jay Stewart",
    nameEn: "Jay Stewart",
    roleKey: "web.about.founders.jay.role",
    bioKey: "web.about.founders.jay.bio",
  },
];

export default async function AboutPage() {
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const t = await getT();

  const TRUST_POINTS = [
    {
      icon: Wallet,
      title: t("web.about.trust.stripe.title"),
      body: t("web.about.trust.stripe.body"),
    },
    {
      icon: ShieldCheck,
      title: t("web.about.trust.dataProtected.title"),
      body: t("web.about.trust.dataProtected.body"),
    },
    {
      icon: GraduationCap,
      title: t("web.about.trust.realTeacher.title"),
      body: t("web.about.trust.realTeacher.body"),
    },
    {
      icon: Globe,
      title: t("web.about.trust.globalPay.title"),
      body: t("web.about.trust.globalPay.body"),
    },
    // The only card that leaves the site, and the one that lets a reader check
    // every other card for herself: the repository is public under
    // AGPL-3.0-only, so "your data is protected" is inspectable rather than
    // asserted. The licence is interpolated from the shared constant so this
    // copy cannot drift from the LICENSE file in any of the three locales.
    {
      icon: Code2,
      title: t("web.about.trust.openSource.title"),
      body: t("web.about.trust.openSource.body", { licence: SOURCE_CODE_LICENCE }),
      href: SOURCE_CODE_URL,
      linkLabel: t("web.about.trust.openSource.link"),
    },
  ];

  // The rhythm between this page's top-level sections is declared once, on the
  // shell, rather than as the same top margin repeated on every one of them.
  // `space-y-14` overrides PageShell's default `space-y-6` through the shell's
  // own cn(), so no child has to out-specify the container to be spaced.
  return (
    <PageShell width="wide" className="space-y-14">
      <header className="text-center">
        <p className="inline-flex items-center gap-1.5 rounded-full border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          {t("web.about.eyebrow")}
        </p>
        <Heading level={1} className="mt-4 lg:text-display">
          {t("web.about.headline")}
        </Heading>
        <p className="mx-auto mt-4 max-w-reading text-lg text-pretty text-muted-foreground">
          {t("web.about.sub")}
        </p>
      </header>

      {/* Founders */}
      <section>
        <Heading level={2} className="text-center">
          {t("web.about.whoBuiltIt")}
        </Heading>
        <div className="mx-auto mt-8 grid max-w-reading gap-6">
          {FOUNDERS.map((f) => (
            <div key={f.nameEn} className="rounded-2xl border bg-card p-6 shadow-xs">
              <div className="flex items-center gap-4">
                {/* The shared avatar, not a copy of it. The copy that used to
                    live here painted its monogram fallback as `text-primary` on
                    `bg-primary/10` — the composited tint PersonAvatar and the
                    Badge variants were both migrated off, because a 10% wash
                    over whatever surface it lands on is a colour no token names
                    and palette-contrast.test.ts therefore cannot assert. On the
                    dark card it measured 4.24:1 and axe found it. It only
                    started rendering when the founder photograph came out of
                    this file, which is the general shape worth keeping: a
                    fallback nobody exercises is a fallback nobody has checked. */}
                <PersonAvatar name={en ? f.nameEn : f.nameEs} photoUrl={f.photo} size={56} />
                <div>
                  <h3 className="font-display text-lg font-semibold">{en ? f.nameEn : f.nameEs}</h3>
                  <p className="text-sm text-muted-foreground">{t(f.roleKey)}</p>
                </div>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{t(f.bioKey)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why / mission */}
      <section className="rounded-3xl border bg-muted/20 p-8 lg:p-10">
        <div className="mx-auto flex max-w-reading flex-col items-center gap-3 text-center">
          <Heart className="h-6 w-6 text-primary" aria-hidden />
          <Heading level={2}>{t("web.about.ourWhy.title")}</Heading>
          <p className="text-pretty text-muted-foreground">{t("web.about.ourWhy.body")}</p>
        </div>
      </section>

      {/* Trust */}
      <section>
        <Heading level={2} className="text-center">
          {t("web.about.whyTrust")}
        </Heading>
        {/* Three across rather than four: the fifth card would otherwise sit
            alone on its own row at xl. */}
        <div className="mt-8 grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
          {TRUST_POINTS.map((p) => {
            const Icon = p.icon;
            return (
              <div key={p.title} className="rounded-2xl border bg-card p-6 shadow-xs">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <h3 className="mt-4 font-display text-h3 font-semibold">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                {"href" in p && p.href ? (
                  <a
                    href={p.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
                  >
                    {p.linkLabel}
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <div className="rounded-3xl bg-primary px-6 py-14 text-center text-primary-foreground">
        <Heading level={2}>{t("web.trialBand.title")}</Heading>
        <p className="mt-3 text-primary-foreground">{t("web.trialBand.noCard")}</p>
        <div className="mt-7 flex flex-col items-center gap-3 lg:flex-row lg:justify-center">
          <Button asChild size="lg" variant="secondary">
            <Link href="/sign-up">{t("web.trialBand.createAccount")}</Link>
          </Button>
          <Button asChild size="lg" variant="outlineOnPrimary">
            <Link href="/features">{t("web.about.seeFeatures")}</Link>
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
