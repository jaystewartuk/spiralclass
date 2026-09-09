import type { ReactNode } from "react";
import { LocaleProvider } from "@/components/locale-provider";
import { funnelLocaleForSlug } from "@/lib/booking/funnel-locale";

// Pins every Client Component under /b/** to the public funnel's locale,
// overriding the request-locale provider the root layout installs.
//
// Why a layout rather than a prop on each component: the funnel is a dozen
// client components across four routes (purchase-flow, checkout-form, the slot
// picker, the lead form, the video card, the error boundary), all reading
// `useT()` from the same React context. Threading a
// locale prop through every one of them would leave the next component added
// here silently following the browser again — the exact drift that produced
// the split-language funnel this fixes, where the landing page rendered
// Spanish for a Spanish browser and the payment form rendered English
// regardless.
//
// The server half of the same rule is getPublicFunnelT() (lib/i18n.ts), fed
// from this same value.
//
// It sits under `[slug]` rather than at `/b` because the funnel's language is
// the TEACHER's (see publicFunnelLocaleFor): the layout has to know whose page
// this is, and only the slug segment does.
export default async function PublicFunnelLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const locale = await funnelLocaleForSlug(slug);
  return (
    <LocaleProvider locale={locale}>
      {/* `lang` on a wrapper element, because a nested layout cannot reach the
          root layout's <html lang>, which is set from the REQUEST locale. Without
          this, a Spanish-browser visitor got lang="es-MX" on a page whose every
          string renders in English — and `lang` is not decoration:
            * Chrome/Edge offer (and remember an always-translate choice for)
              translation of a page whose declared language isn't the reader's,
              so the funnel could be machine-translated back into Spanish — the
              one outcome PUBLIC_FUNNEL_LOCALE exists to prevent;
            * screen readers switch voice/pronunciation rules off it, reading
              English copy with Spanish phonetics;
            * Google treats it as a language signal for indexing.
          `lang` inherits down the subtree and the nearest declaration wins, so
          this correctly scopes the teacher's language to the funnel while the
          rest of the document keeps the visitor's. A plain <div> is safe here: the
          root layout's #main-content is an ordinary block container, so the
          extra element drives no layout of its own. */}
      <div lang={locale}>{children}</div>
    </LocaleProvider>
  );
}
