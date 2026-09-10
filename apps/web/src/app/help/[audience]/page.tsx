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
        <p className="text-primary text-sm font-semibold">{t(AUDIENCE_LABEL_KEY[typedAudience])}</p>
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
              className="group border-border bg-card hover:border-primary/40 hover:shadow-brand-sm flex items-start gap-4 rounded-xl border p-4 transition-[border-color,box-shadow]"
            >
              <span className="min-w-0 flex-1">
                <span className="text-foreground block font-semibold">
                  {localize(doc.title, locale)}
                </span>
                <span className="text-muted-foreground mt-1 block text-sm text-pretty">
                  {localize(doc.summary, locale)}
                </span>
              </span>
              <ArrowRight
                className="text-muted-foreground group-hover:text-foreground mt-1 h-4 w-4 shrink-0 transition-colors"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
