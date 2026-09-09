"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({
  children,
  nonce,
}: {
  children: React.ReactNode;
  // CSP nonce for next-themes' pre-paint no-flash <script>, so it isn't blocked
  // under an enforcing Content-Security-Policy. Sourced from the x-nonce request
  // header set in middleware.
  nonce?: string;
}) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
