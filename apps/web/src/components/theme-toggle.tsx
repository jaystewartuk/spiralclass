"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useT } from "@/components/locale-provider";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const t = useT();

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <span className="h-4 w-4" aria-hidden />;
  }

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? t("web.themeToggle.switchToLight") : t("web.themeToggle.switchToDark")}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
      {isDark ? t("web.themeToggle.light") : t("web.themeToggle.dark")}
    </button>
  );
}
