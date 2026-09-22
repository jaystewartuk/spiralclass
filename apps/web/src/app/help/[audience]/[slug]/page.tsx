import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
  getContentDoc,
  listContentDocs,
  localize,
  type ContentAudience,
} from "@spiralclass/shared";
import { requireOnboardedTeacher, requireStudent } from "@/lib/auth";
import { requireAdmin } from "@/lib/admin";
import { getT, getPreferredLocale } from "@/lib/i18n";
import type { StringKey } from "@/lib/i18n-translate";
import { Heading } from "@/components/ui/heading";
import { PageShell } from "@/components/ui/page-shell";
import { AnchoredHeading } from "@/components/help/anchored-heading";
import { HelpPageHeader } from "@/components/help/help-page-header";
import { MarkdownArticle } from "@/components/markdown-article";
import { prepareHelpGuides } from "@/lib/help/guides";

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

// Every audience segment requires the matching session — this route serves
// deep links from in-app HelpHint tooltips, not the public marketing FAQ
// (that's the ungated /help page, which sources its own subset of docs).
async function gate(audience: ContentAudience) {
  if (audience === "teacher") return requireOnboardedTeacher();
  if (audience === "student") return requireStudent();
  return requireAdmin();
}

type PageParams = { audience: string; slug: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { audience, slug } = await params;
  if (!AUDIENCES.has(audience)) return {};
  const doc = getContentDoc(audience as ContentAudience, slug);
  if (!doc) return {};
  const locale = await getPreferredLocale();
  return {
    title: localize(doc.title, locale),
    description: localize(doc.summary, locale),
    robots: { index: false, follow: false },
  };
}

export default async function HelpDocPage({ params }: { params: Promise<PageParams> }) {
  const { audience, slug } = await params;
  if (!AUDIENCES.has(audience)) notFound();
  const typedAudience = audience as ContentAudience;
  await gate(typedAudience);

  const doc = getContentDoc(typedAudience, slug);
  if (!doc) notFound();

  const t = await getT();
  const locale = await getPreferredLocale();

  // One article, prepared the same way the public help centre prepares four:
  // anchored sections, and cross-references pointed at their sibling ROUTE
  // (the source .md files link to each other as `packages-and-payments.md`,
  // which resolves to a 404 if it reaches the browser unrewritten). A slug
  // this audience does not have unwraps to plain text rather than linking
  // into a doc the reader's session cannot open.
  const siblings = new Set(listContentDocs(typedAudience).map((d) => d.slug));
  const [guide] = prepareHelpGuides([doc], locale, (target) =>
    siblings.has(target) ? `/help/${typedAudience}/${target}` : null,
  );

  return (
    <PageShell width="reading">
      <HelpPageHeader backHref={BACK_HREF[typedAudience]} backLabel={t(BACK_KEY[typedAudience])} />

      <nav
        aria-label={t("web.help.title")}
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <Link href={`/help/${typedAudience}`} className="rounded-sm hover:text-foreground">
          {t(AUDIENCE_LABEL_KEY[typedAudience])}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <span className="text-foreground">{guide.title}</span>
      </nav>

      <article>
        <Heading level={1} as="h1" className="text-balance">
          {guide.title}
        </Heading>
        <p className="mt-2 text-pretty text-muted-foreground">{guide.summary}</p>

        <div className="mt-8 space-y-10">
          {guide.sections.map((section) => (
            <section key={section.id} id={section.id} className="scroll-mt-8">
              <AnchoredHeading
                targetId={section.id}
                level={2}
                as="h2"
                label={section.heading}
                linkLabel={t("web.help.anchorLinkTo", { section: section.heading })}
                className="mb-4 border-b border-border pb-2 text-foreground"
              />
              <MarkdownArticle content={section.body} headingOffset={1} />
            </section>
          ))}
        </div>
      </article>
    </PageShell>
  );
}
