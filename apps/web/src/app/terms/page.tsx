import { Heading } from "@/components/ui/heading";
import type { Metadata } from "next";
import Link from "next/link";
import { SUPPORT_EMAIL } from "@/lib/support";
import { Logo } from "@/components/brand/logo";
import { hasStripeCreds } from "@/lib/env";
import { createT } from "@/lib/i18n-translate";
import { getPreferredLocale } from "@/lib/i18n";
import { localizedAlternates, pageLanguages } from "@/lib/seo/localized-alternates";
import {
  localizedHref,
  localizedPath,
  termsDocumentFor,
  type TermsDocument,
  type TermsInline,
} from "@spiralclass/shared";
import { CANCELLATION_POLICY_ANCHOR, LEGACY_CANCELLATION_ANCHOR } from "@/lib/terms-anchors";

// The Terms of Service. A renderer with no copy of its own: the two authored
// documents, English and its Spanish translation, are data in
// packages/shared/src/legal/terms.ts (D-196), as the privacy policy is.
//
// The URL decides which is shown (D-193): `/terms` is English and `/es/terms`
// Spanish. Every other language's URL serves the English text, which is the
// one that applies, with a line in the reader's language saying so. So does
// `/es/terms` while the Spanish translation is behind the English. The old
// `?lang=es` links in sent email are redirected to `/es/terms` by the
// middleware.

/**
 * The cancellation clause's previous fragment, kept addressable.
 *
 * A URL fragment never reaches the server, so nothing can redirect one — a
 * renamed id is only ever a link that silently lands at the top of a long
 * legal page. Cancellation and deduction emails carry this one and are already
 * in people's inboxes, so it stays reachable as an empty target rather than
 * being carried by the section itself: an element has one id, and the one it
 * announces should be the current one.
 *
 * Every document renders through the one function below, so a link works
 * whichever document the reader lands on.
 */
function LegacyCancellationAnchor() {
  return <span id={LEGACY_CANCELLATION_ANCHOR} aria-hidden="true" />;
}

// Metadata follows the URL's language. The documents are each other's
// alternates; every other language's URL canonicalises to `/terms`, because
// the document it serves is the English one (localizedAlternates).
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getPreferredLocale();
  const t = createT(locale);
  return {
    title: t("web.terms.meta.title"),
    description: t("web.terms.meta.description"),
    alternates: localizedAlternates("/terms", locale),
  };
}

export default async function TermsPage() {
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const href = (path: string) => localizedHref(path, locale);
  const { document, translationOutdated } = termsDocumentFor(locale);
  return (
    <main className="container space-y-6 py-10 text-sm leading-relaxed lg:max-w-2xl">
      <Link href={href("/")} aria-label={t("common.brandName")} className="inline-block">
        <Logo size="sm" />
      </Link>
      {translationOutdated ? (
        <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          {t("web.legal.translationOutdated")}
        </p>
      ) : (
        !pageLanguages("/terms").includes(locale) && (
          <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            {t("web.legal.englishOnly")}
          </p>
        )
      )}
      <TermsArticle document={document} stripeAvailable={hasStripeCreds()} href={href} />
    </main>
  );
}

function TermsArticle({
  document,
  stripeAvailable,
  href,
}: {
  document: TermsDocument;
  stripeAvailable: boolean;
  /** Links to other public pages, in the language the page is rendered in. */
  href: (path: string) => string;
}) {
  return (
    <article lang={document.lang} className="space-y-4">
      <header>
        <Heading level={2} as="h1">
          {document.title}
        </Heading>
        <p className="text-xs text-muted-foreground">
          {document.lastUpdated} ·{" "}
          {/* A full load: the other document is the other language's URL, and
              the root layout carries the language (D-193). */}
          <a
            className="underline"
            href={localizedPath("/terms", document.switchTo.locale)}
            hrefLang={document.switchTo.locale}
          >
            {document.switchTo.label}
          </a>
        </p>
      </header>

      {document.sections.map((section) => (
        <TermsSectionView
          key={section.heading}
          section={section}
          stripeAvailable={stripeAvailable}
          href={href}
        />
      ))}
    </article>
  );
}

function TermsSectionView({
  section,
  stripeAvailable,
  href,
}: {
  section: TermsDocument["sections"][number];
  stripeAvailable: boolean;
  href: (path: string) => string;
}) {
  const isCancellation = section.anchor === "cancellationPolicy";
  return (
    <>
      {isCancellation && <LegacyCancellationAnchor />}
      <section id={isCancellation ? CANCELLATION_POLICY_ANCHOR : undefined} className="space-y-2">
        <Heading level={4} as="h2">
          {section.heading}
        </Heading>
        {section.paragraphs.map((paragraph, i) => (
          <p key={i}>
            {paragraph.map((run, j) => (
              <InlineRun key={j} run={run} stripeAvailable={stripeAvailable} href={href} />
            ))}
          </p>
        ))}
      </section>
    </>
  );
}

function InlineRun({
  run,
  stripeAvailable,
  href,
}: {
  run: TermsInline;
  stripeAvailable: boolean;
  href: (path: string) => string;
}) {
  if (typeof run === "string") return <>{run}</>;
  switch (run.kind) {
    case "ifStripe":
      return <>{stripeAvailable ? run.text : ""}</>;
    case "contactEmail":
      return (
        <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
          {SUPPORT_EMAIL}
        </a>
      );
    case "privacyLink":
      return (
        <Link className="underline" href={href("/privacy-notice")}>
          {run.text}
        </Link>
      );
  }
}
