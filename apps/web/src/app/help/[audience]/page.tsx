import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { listContentDocs, localize, type ContentAudience } from "@spiralclass/shared";
import { requireOnboardedTeacher, requireStudent } from "@/lib/auth";
import { requireAdmin } from "@/lib/admin";
import { getT, getPreferredLocale } from "@/lib/i18n";
import type { StringKey } from "@/lib/i18n-translate";
import { Heading } from "@/components/ui/heading";
import { PageShell } from "@/components/ui/page-shell";
import { HelpPageHeader } from "@/components/help/help-page-header";

const AUDIENCES = new Set<string>(["teacher", "student", "admin"]);

const BACK_HREF: Record<ContentAudience, string> = {
  teacher: "/dashboard",
  student: "/my-classes",
  admin: "/admin",
};

const BACK_KEY: Record<ContentAudience, StringKey> = {
  teacher: "web.help.backToDashboard",
  student: "web.help.backToPortal",
  admin: "web.help.backToAdmin",
};

const AUDIENCE_LABEL_KEY: Record<ContentAudience, StringKey> = {
  teacher: "web.help.audience.teacher",
  student: "web.help.audience.student",
  admin: "web.help.audience.admin",
};

async function gate(audience: ContentAudience) {
  if (audience === "teacher") return requireOnboardedTeacher();
  if (audience === "student") return requireStudent();
  return requireAdmin();
}

type PageParams = { audience: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { audience } = await params;
  if (!AUDIENCES.has(audience)) return {};
  const t = await getT();
  return {
    title: `${t(AUDIENCE_LABEL_KEY[audience as ContentAudience])} — ${t("web.help.title")}`,
    robots: { index: false, follow: false },
  };
}

export default async function HelpAudienceIndexPage({ params }: { params: Promise<PageParams> }) {
  const { audience } = await params;
  if (!AUDIENCES.has(audience)) notFound();
  const typedAudience = audience as ContentAudience;
  await gate(typedAudience);

  const docs = listContentDocs(typedAudience);
  const t = await getT();
  const locale = await getPreferredLocale();

  return (
    <PageShell>
      <HelpPageHeader backHref={BACK_HREF[typedAudience]} backLabel={t(BACK_KEY[typedAudience])} />

      <header>
        <p className="text-sm font-semibold text-primary">{t(AUDIENCE_LABEL_KEY[typedAudience])}</p>
        <Heading level={1} as="h1" className="mt-1 text-balance">
          {t("web.help.title")}
        </Heading>
      </header>

      {/* A list, not a grid of cards: these are read in order the first time
          and scanned by title afterwards, and a one-column list is what a
          reader's eye can run down without re-finding the left edge. */}
      <ul aria-label={t("web.help.articleList.label")} className="space-y-3">
        {docs.map((doc) => (
          <li key={doc.slug}>
            <Link
              href={`/help/${typedAudience}/${doc.slug}`}
              className="group flex items-start gap-4 rounded-xl border border-border bg-card p-4 transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-brand-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-foreground">
                  {localize(doc.title, locale)}
                </span>
                <span className="mt-1 block text-sm text-pretty text-muted-foreground">
                  {localize(doc.summary, locale)}
                </span>
              </span>
              <ArrowRight
                className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
