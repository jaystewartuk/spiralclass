// SpiralClass — platform expense vendor/category config.
//
// KNOWN_EXPENSE_VENDORS is a curated, extensible list (NOT a DB enum) so a
// new vendor can be added here without a migration — see PlatformExpense in
// apps/web/prisma/schema.prisma. Shared so web and mobile resolve the same
// vendor set / default categories. ExpenseCategory mirrors the Prisma
// ExpenseCategory enum of the same name; keep the two in sync by hand
// (Prisma enums can't import from here).

export const EXPENSE_CATEGORIES = [
  "hosting",
  "ai",
  "dev_tools",
  "monitoring",
  "email",
  "domain",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

// Mirrors docs/deployment/COST_PLAYBOOK.md's component list, plus the dev-tool
// spend the playbook doesn't itemize (Claude Code, Deepgram).
export const KNOWN_EXPENSE_VENDORS = [
  "vercel",
  "supabase",
  "sentry",
  "resend",
  "uptimerobot",
  "anthropic_api",
  "claude_code",
  "github_actions",
  "deepgram",
  "domain_registrar",
  "other",
] as const;
export type ExpenseVendor = (typeof KNOWN_EXPENSE_VENDORS)[number];

// Default category for each known vendor — the create form pre-selects this;
// the admin can still override it per entry.
export const DEFAULT_EXPENSE_CATEGORY: Record<ExpenseVendor, ExpenseCategory> = {
  vercel: "hosting",
  supabase: "hosting",
  sentry: "monitoring",
  resend: "email",
  uptimerobot: "monitoring",
  anthropic_api: "ai",
  claude_code: "ai",
  github_actions: "dev_tools",
  deepgram: "ai",
  domain_registrar: "domain",
  other: "other",
};

export function isKnownExpenseVendor(vendor: string): vendor is ExpenseVendor {
  return (KNOWN_EXPENSE_VENDORS as readonly string[]).includes(vendor);
}
