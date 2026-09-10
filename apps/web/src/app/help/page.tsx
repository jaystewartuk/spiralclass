// Public, unauthenticated help centre. No DB access, no auth. Sourced from the
// content registry (@spiralclass/shared) instead of hand-duplicated copy, so
// this page and the gated /help/[audience]/[slug] deep links can never drift
// apart on what the platform actually says. Content is generated from
// docs/help/*.md — es-MX where translated, falling back to English (no `fr`
// variant yet — see localize()).
// Locale follows the global `getPreferredLocale()` (cookie + Accept-Language),
// same as the rest of the app — use the LanguagePicker in the footer/nav to flip.
//
// SHAPE. Four guides, ~14,000 characters, on one URL. That is deliberate — it
// is the canonical FAQ page, splitting it across four routes would fragment
// what little search authority it has for no reader's benefit — but a single
// column of that length is only usable if there are three ways into it, so
// there are: a search that indexes every section and every question in them
// (lib/help/search.ts), a contents rail that follows the reader on desktop,
// and sticky jump pills on a phone. Every one of those is generated from the
// SAME prepared guides the article renders, so a link and its target cannot
// come from two different computations of an anchor id.

import { Heading } from "@/components/ui/heading";
import type { Metadata } from "next";
import Link from "next/link";
import { GraduationCap, LifeBuoy, Users } from "lucide-react";
import { listPublicFaqDocs } from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionNav } from "@/components/ui/section-nav";
import { CtaBand } from "@/components/marketing/cta-band";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { AnchoredHeading } from "@/components/help/anchored-heading";
import { HelpSearch } from "@/components/help/help-search";
import { HelpToc } from "@/components/help/help-toc";
import { JsonLd } from "@/components/json-ld";
import { MarkdownArticle } from "@/components/markdown-article";
import { anchorLinkResolver, prepareHelpGuides } from "@/lib/help/guides";
import { collectHelpFaq } from "@/lib/help/faq";
import { buildHelpSearchEntries } from "@/lib/help/search";
import { getT, getPreferredLocale } from "@/lib/i18n";
import { faqPageJsonLd } from "@/lib/seo/jsonld";
import { SUPPORT_EMAIL } from "@/lib/support";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  const title = t("web.help.meta.title");
  const description = t("web.help.meta.description");
  return {
    title,
    description,
    alternates: { canonical: "/help" },
    // Next inherits `openGraph` from the root layout but does NOT fill its
    // title/description from a page's own — without these the card for a
    // shared help link carries the site defaults and says nothing about help.
    openGraph: { title, description, url: "/help", type: "website" },
  };
}

export default async function HelpPage() {
  const t = await getT();
  const locale = await getPreferredLocale();
  const docs = listPublicFaqDocs();

  // One parse feeds the article, the contents rail, the search index and the
  // structured data. Cross-references between these four guides resolve to an
  // anchor on this page; anything pointing outside the public set unwraps to
  // plain text rather than to a link a signed-out reader cannot follow.
  const guides = prepareHelpGuides(docs, locale, anchorLinkResolver(docs));
  const searchEntries = buildHelpSearchEntries(guides);

  // FAQPage structured data built from the real questions inside the same
  // bodies the sections below render, so the markup can never say something
  // the visible page doesn't.
  const faq = collectHelpFaq(guides);

  return (
    <main className="flex flex-col">
      {faq.length > 0 && <JsonLd data={faqPageJsonLd(faq)} />}
      <MarketingHeader />

      {/* Hero — the search field is the page's primary action, so it gets the
          centre of the one band that is allowed to be quiet. */}
      <section className="border-b">
        {/* `overflow-hidden` belongs on the DECORATIVE layer, not on this
            wrapper: putting it here clipped the search results panel, which is
            absolutely positioned and has to escape the hero. */}
        <div className="relative">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
            <div className="bg-primary/10 absolute top-0 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full blur-3xl" />
          </div>
          <div className="container flex flex-col items-center gap-5 py-14 text-center lg:py-20">
            <Badge variant="secondary" className="gap-1.5 px-3 py-1">
              <LifeBuoy className="h-3.5 w-3.5" aria-hidden />
              {t("web.help.hero.eyebrow")}
            </Badge>
            <Heading level={1} className="max-w-reading lg:text-display text-balance">
              {t("web.help.hero.title")}
            </Heading>
            <p className="max-w-reading text-muted-foreground text-lg text-pretty">
              {t("web.help.hero.sub")}
            </p>
            <div className="mt-2 w-full max-w-xl">
              <HelpSearch entries={searchEntries} />
            </div>
          </div>
        </div>
      </section>

      <div className="container py-10 lg:flex lg:gap-12 lg:py-14">
        {/* Contents rail — desktop only. The phone gets the jump pills below,
            which are the same idea at one level of depth. */}
        <aside className="hidden w-64 shrink-0 lg:block">
          <div className="max-h-rail sticky top-8 overflow-y-auto">
            <Heading level={4} as="p" className="text-foreground mb-3">
              {t("web.help.onThisPage")}
            </Heading>
            <HelpToc
              ariaLabel={t("web.help.toc.label")}
              guides={guides.map((guide) => ({
                id: guide.id,
                label: guide.title,
                sections: guide.sections.map((section) => ({
                  id: section.id,
                  label: section.heading,
                })),
              }))}
            />
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <SectionNav
            ariaLabel={t("web.help.sectionNav.label")}
            className="top-0 lg:hidden"
            sections={guides.map((guide) => ({ id: guide.id, label: guide.title }))}
          />

          <div className="mt-8 space-y-16 lg:mt-0">
            {guides.map((guide) => (
              <article
                key={guide.slug}
                id={guide.id}
                // A rule between guides rather than only space: four articles
                // of six sections each need a boundary that survives being
                // scrolled past at speed.
                className="border-border scroll-mt-8 border-t pt-14 first:border-t-0 first:pt-0"
              >
                {/* 30px against the sections' 22px and the body's 17px. The
                    guide title used to sit at 22px, one step from its own
                    section headings, and the page read as one flat list of
                    twenty-four headings rather than as four articles. */}
                <AnchoredHeading
                  targetId={guide.id}
                  level={1}
                  as="h2"
                  label={guide.title}
                  linkLabel={t("web.help.anchorLinkTo", { section: guide.title })}
                />
                <p className="max-w-reading text-muted-foreground mt-3 text-lg text-pretty">
                  {guide.summary}
                </p>

                <div className="mt-10 space-y-10">
                  {guide.sections.map((section) => (
                    // The reading cap sits on the whole section, heading rule
                    // included — a rule that runs past the text it belongs to
                    // reads as a page divider, not a heading.
                    <section key={section.id} id={section.id} className="max-w-reading scroll-mt-8">
                      <AnchoredHeading
                        targetId={section.id}
                        level={2}
                        as="h3"
                        label={section.heading}
                        linkLabel={t("web.help.anchorLinkTo", { section: section.heading })}
                        className="border-border text-foreground mb-4 border-b pb-2"
                      />
                      {/* The article's own `##` became the `<h3>` above, so
                          everything inside it drops one level: a `###` here is
                          the fourth level of the outline, not the third. */}
                      <MarkdownArticle content={section.body} headingOffset={1} />
                    </section>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>

      {/* The rest of the help centre is per-audience and behind a session —
          say so plainly rather than letting a reader discover it at a sign-in
          redirect. */}
      <section className="bg-secondary/40 border-y">
        <div className="container py-14">
          <Heading level={2} as="h2" className="max-w-reading text-balance">
            {t("web.help.inApp.title")}
          </Heading>
          <p className="max-w-reading text-muted-foreground mt-2 text-pretty">
            {t("web.help.inApp.sub")}
          </p>
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            {[
              {
                href: "/help/teacher",
                icon: GraduationCap,
                title: t("web.help.audience.teacher"),
                body: t("web.help.inApp.teacher.body"),
              },
              {
                href: "/help/student",
                icon: Users,
                title: t("web.help.audience.student"),
                body: t("web.help.inApp.student.body"),
              },
            ].map((item) => (
              <Card key={item.href} className="flex flex-col">
                <CardHeader>
                  <div className="bg-primary/10 text-primary flex h-11 w-11 items-center justify-center rounded-xl">
                    <item.icon className="h-5 w-5" aria-hidden />
                  </div>
                  {/* `text-lg` (19px), not `text-h3`: both resolve to the same
                      step, but only the Tailwind key is one tailwind-merge can
                      recognise as a font size and use to displace CardTitle's
                      own `text-2xl`. */}
                  <CardTitle as="h3" className="mt-4 text-lg">
                    {item.title}
                  </CardTitle>
                  <CardDescription className="text-pretty">{item.body}</CardDescription>
                </CardHeader>
                <CardContent className="mt-auto">
                  <Button asChild variant="outline">
                    <Link href={item.href}>{t("web.help.inApp.cta")}</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <CtaBand
        title={t("web.help.contact.title")}
        primaryHref={`mailto:${SUPPORT_EMAIL}`}
        primaryLabel={t("web.help.contact.cta", { email: SUPPORT_EMAIL })}
        secondaryHref="/features"
        secondaryLabel={t("web.help.contact.secondary")}
      />
    </main>
  );
}
