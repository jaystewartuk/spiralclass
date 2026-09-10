import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// The closing `bg-primary` conversion band shared by the landing and features
// pages. Presentational and string-free — copy + hrefs are passed in, so the
// auth-awareness (which href/label to use) stays in the calling page.
export function CtaBand({
  title,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
}: {
  title: string;
  primaryHref: string;
  primaryLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <section className="container py-20">
      <div className="bg-primary text-primary-foreground relative overflow-hidden rounded-3xl px-6 py-14 text-center">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-0 opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle at 80% 20%, hsl(var(--accent) / 0.5), transparent 45%)",
          }}
        />
        <Heading level={2} className="relative mx-auto max-w-xl text-balance lg:text-3xl">
          {title}
        </Heading>
        <div className="relative mt-7 flex flex-col items-center gap-3 lg:flex-row lg:justify-center">
          <Button asChild size="lg" variant="secondary">
            <Link href={primaryHref}>{primaryLabel}</Link>
          </Button>
          {secondaryHref && secondaryLabel && (
            <Link
              href={secondaryHref}
              className="text-primary-foreground hover:text-primary-foreground text-sm underline-offset-4 hover:underline"
            >
              {secondaryLabel}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
