import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";

// Sign-in/sign-up are linked from every public page, so they must stay
// CRAWLABLE (no robots.txt disallow) for this noindex to be seen — a
// disallowed-but-linked URL can still be indexed reference-less.
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="container flex min-h-dvh flex-col items-center justify-center gap-8 py-12">
      <Link href="/" aria-label="SpiralClass">
        <Logo size="md" />
      </Link>
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
