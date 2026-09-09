// The privacy policy. Static — no DB access, no auth.
//
// The document itself lives in @spiralclass/shared (`legal/privacy-policy.ts`)
// and the supplier list in `legal/subprocessors.ts`, so any renderer shows the
// SAME document from the SAME source. This page is a renderer and
// deliberately holds no copy of its own — it is on the `i18n/no-literal-string`
// allowlist, and legal text is authored in English and never machine-translated
// (D-81), so the two rules together mean the words belong in a data module
// rather than here or in the i18n catalog.
//
// What this replaced: a bilingual `Aviso de privacidad` written under Mexico's
// LFPDPPP, whose two variants were keyed `…privacy.es.*` / `…privacy.en.*`
// inside a per-locale catalog. `catalog.fr.ts` had therefore machine-translated
// both variants into French, so a French reader was shown a link labelled
// "Español" that rendered in French. The controller is UK-established (D-58)
// and the Terms are already governed by the laws of England and Wales, so the
// document is UK GDPR / DPA 2018 shaped.

import { Heading } from "@/components/ui/heading";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import Link from "next/link";
import {
  CONTROLLER,
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_LABELS,
  PRIVACY_POLICY_INTRO,
  PRIVACY_POLICY_LAST_UPDATED,
  PRIVACY_POLICY_SECTIONS,
  PRIVACY_POLICY_TITLE,
  SUBPROCESSORS_REVIEWED,
  coreSubprocessors,
  gatedSubprocessors,
  type PolicyBlock,
  type PolicySection,
  type Subprocessor,
} from "@spiralclass/shared";
import { Logo } from "@/components/brand/logo";
import { getT } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("web.privacyNotice.meta.title"),
    description: t("web.privacyNotice.meta.description"),
    alternates: { canonical: "/privacy-notice" },
  };
}

export default async function PrivacyNoticePage() {
  const t = await getT();
  return (
    <main className="container space-y-8 py-10 text-sm leading-relaxed lg:max-w-3xl">
      <Link href="/" aria-label={t("common.brandName")} className="inline-block">
        <Logo size="sm" />
      </Link>

      {/* `lang` is pinned to English: the document is authored in English and is
          not translated, so a screen reader must not announce it in the page
          locale. Everything inside this element comes from the shared module. */}
      <article lang="en" className="space-y-8">
        <header className="space-y-2">
          <PageHeader title={PRIVACY_POLICY_TITLE} />
          <p className="text-xs text-muted-foreground">
            {PRIVACY_LABELS.lastUpdated} {PRIVACY_POLICY_LAST_UPDATED}
          </p>
          <p>{PRIVACY_POLICY_INTRO}</p>
        </header>

        {PRIVACY_POLICY_SECTIONS.map((section) => (
          <Section key={section.id} section={section} />
        ))}
      </article>
    </main>
  );
}

function Section({ section }: { section: PolicySection }) {
  return (
    <section id={section.id} className="space-y-3">
      <Heading level={4} as="h2">
        {section.heading}
      </Heading>
      {section.blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </section>
  );
}

function Block({ block }: { block: PolicyBlock }) {
  switch (block.kind) {
    case "text":
      return <p>{block.text}</p>;

    case "list":
      return (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );

    case "basisTable":
      return (
        // Wide content scrolls inside its own container, so the page body never
        // scrolls horizontally on a phone.
        <div className="overflow-x-auto">
          <table className="w-full min-w-table border-collapse text-left">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4 font-semibold">{PRIVACY_LABELS.basisPurpose}</th>
                <th className="py-2 pr-4 font-semibold">{PRIVACY_LABELS.basisData}</th>
                <th className="py-2 font-semibold">{PRIVACY_LABELS.basisBasis}</th>
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row.purpose} className="border-b align-top last:border-0">
                  <td className="py-2 pr-4">{row.purpose}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{row.data}</td>
                  <td className="py-2">
                    {row.basis}
                    {row.interest ? (
                      <span className="block text-xs text-muted-foreground">{row.interest}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "retentionTable":
      return (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse text-left">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4 font-semibold">{PRIVACY_LABELS.retentionWhat}</th>
                <th className="py-2 font-semibold">{PRIVACY_LABELS.retentionHowLong}</th>
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row.what} className="border-b align-top last:border-0">
                  <td className="py-2 pr-4">{row.what}</td>
                  <td className="py-2 text-muted-foreground">{row.howLong}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "subprocessors":
      return (
        <div className="space-y-4">
          <SubprocessorTable caption={PRIVACY_LABELS.suppliersCore} rows={coreSubprocessors()} />
          <SubprocessorTable caption={PRIVACY_LABELS.suppliersGated} rows={gatedSubprocessors()} />
          <p className="text-xs text-muted-foreground">
            {PRIVACY_LABELS.suppliersReviewed} {SUBPROCESSORS_REVIEWED}
          </p>
        </div>
      );

    case "contact":
      return (
        <p>
          <a className="underline" href={`mailto:${PRIVACY_CONTACT_EMAIL}`}>
            {PRIVACY_CONTACT_EMAIL}
          </a>
          <span className="block text-xs text-muted-foreground">
            {PRIVACY_LABELS.controllerLine}: {CONTROLLER.name}, {CONTROLLER.establishment}
          </span>
        </p>
      );
  }
}

function SubprocessorTable({ caption, rows }: { caption: string; rows: readonly Subprocessor[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-table border-collapse text-left">
        <caption className="pb-2 text-left text-xs text-muted-foreground">{caption}</caption>
        <thead>
          <tr className="border-b">
            <th className="py-2 pr-4 font-semibold">{PRIVACY_LABELS.supplierName}</th>
            <th className="py-2 pr-4 font-semibold">{PRIVACY_LABELS.supplierPurpose}</th>
            <th className="py-2 pr-4 font-semibold">{PRIVACY_LABELS.supplierData}</th>
            <th className="py-2 font-semibold">{PRIVACY_LABELS.supplierLocation}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b align-top last:border-0">
              <td className="py-2 pr-4 font-medium">{row.name}</td>
              <td className="py-2 pr-4 text-muted-foreground">{row.purpose}</td>
              <td className="py-2 pr-4 text-muted-foreground">{row.dataShared}</td>
              <td className="py-2">{row.location}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
