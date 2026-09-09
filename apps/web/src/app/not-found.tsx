import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { getPreferredLocale } from "@/lib/i18n";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

const COPY = {
  "es-MX": {
    title: "Página no encontrada",
    body: "La página que buscas no existe o ya no está disponible.",
    cta: "Volver al inicio",
  },
  en: {
    title: "Page not found",
    body: "The page you're looking for doesn't exist or is no longer available.",
    cta: "Back to home",
  },
  fr: {
    title: "Page introuvable",
    body: "La page que vous cherchez n'existe pas ou n'est plus disponible.",
    cta: "Retour à l'accueil",
  },
} as const;

export default async function NotFound() {
  const locale = await getPreferredLocale();
  const copy = COPY[locale];
  return (
    <main className="container flex min-h-dvh flex-col items-center justify-center gap-6 py-12 text-center">
      <Link href="/" aria-label="SpiralClass">
        <Logo size="md" />
      </Link>
      <div className="max-w-md space-y-3">
        <Heading level={1}>{copy.title}</Heading>
        <p className="text-muted-foreground">{copy.body}</p>
      </div>
      <Button asChild size="lg">
        <Link href="/">{copy.cta}</Link>
      </Button>
    </main>
  );
}
