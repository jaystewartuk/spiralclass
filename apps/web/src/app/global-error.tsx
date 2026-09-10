"use client";

import { Heading } from "@/components/ui/heading";
import { useEffect, useState } from "react";
import type { AppLocale } from "@/lib/i18n";
import { useSkewRecoveryOrReport } from "@/components/use-server-action-recovery";
// global-error renders outside the root layout, so it must pull in the
// global stylesheet itself for the Tailwind design tokens below to apply.
import "./globals.css";

// Catches errors thrown in the root layout itself (i.e., before any
// route-level error.tsx is reachable). Must render its own <html>/<body>
// because the root layout failed — so it can't rely on LocaleProvider and
// resolves the locale client-side from the cookie / browser language.
// Keeps Sentry capture symmetric with route-level error.tsx, by going
// through the same useSkewRecoveryOrReport hook they do. Uses the
// app's Tailwind design tokens rather than inline styles so the worst-case
// screen still looks like the rest of the product.

const COPY = {
  "es-MX": {
    body: "Tuvimos un problema cargando la aplicación. Vuelve a intentar o escríbenos a support@spiralclass.com.",
    reference: "Referencia",
    home: "Volver al inicio",
  },
  en: {
    body: "We had a problem loading the app. Try again or write to us at support@spiralclass.com.",
    reference: "Reference",
    home: "Back to home",
  },
  fr: {
    body: "Un problème est survenu au chargement de l'application. Réessayez ou écrivez-nous à support@spiralclass.com.",
    reference: "Référence",
    home: "Retour à l'accueil",
  },
} as const;

function detectLocale(): AppLocale {
  if (typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|;\s*)locale=(en|es-MX|fr)/);
    if (match) return match[1] as AppLocale;
  }
  if (typeof navigator !== "undefined") {
    if (/^fr\b/i.test(navigator.language)) return "fr";
    if (/^es\b/i.test(navigator.language)) return "es-MX";
  }
  return "es-MX";
}

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  // Default to es-MX (launch market) for the server render, then refine on
  // the client once cookie/navigator are available.
  const [locale, setLocale] = useState<AppLocale>("es-MX");
  const copy = COPY[locale];
  // Reloads once on a deploy-skew error, and reports anything it does not
  // recover from — including skew that has already used its one reload.
  const recovering = useSkewRecoveryOrReport(error);

  useEffect(() => {
    setLocale(detectLocale());
  }, []);

  if (recovering) return null;

  return (
    <html lang={locale}>
      <body className="m-0 flex min-h-dvh items-center justify-center bg-background p-8 text-center font-sans text-foreground">
        <div className="max-w-md space-y-4">
          <Heading level={1}>SpiralClass</Heading>
          <p className="text-muted-foreground">{copy.body}</p>
          {error.digest && (
            <p className="text-xs text-muted-foreground">
              {copy.reference}: <code>{error.digest}</code>
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              window.location.href = "/";
            }}
            className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden"
          >
            {copy.home}
          </button>
        </div>
      </body>
    </html>
  );
}
