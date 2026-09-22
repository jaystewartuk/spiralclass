import Link from "next/link";
import { Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The primary "join/start the video call" action on a class-detail page. It
// used to live inside a plain Card with the same visual weight as every other
// section (materials, notes, history) — this makes it read as the primary,
// time-sensitive action instead: full-width, accent-colored, its own icon.
// Same underlying link/testID as before; this only changes presentation.
export function CallCta({
  href,
  title,
  subtitle,
  cta,
  className,
}: {
  href: string;
  title: string;
  subtitle?: string;
  cta: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-stretch gap-3 rounded-lg border border-primary bg-primary/10 px-5 py-4 lg:flex-row lg:items-center lg:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Video className="size-6 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{title}</p>
          {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <Button asChild size="lg" className="shrink-0">
        <Link href={href}>{cta}</Link>
      </Button>
    </div>
  );
}
