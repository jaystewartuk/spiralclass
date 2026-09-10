import Link from "next/link";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PAYMENTS_SCOPES, paymentsHref, type PaymentsScope } from "@/lib/payments-list";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

/**
 * The ledger's controls: which view, and which payment.
 *
 * LINKS, NOT A TAB WIDGET — the same call the class roster makes, for the same
 * reasons. Each view is a different server-rendered list at its own URL, so it
 * is navigation: deep-linkable, back-buttonable, middle-clickable, and working
 * with JavaScript off. `aria-current="page"` carries the selected state; a
 * Radix `tablist` would announce a tab interface with no tab panel behind it.
 *
 * The search is a plain GET form with a real submit, deliberately NOT the
 * debounced auto-submit the admin filter bars use: that navigates mid-word and
 * takes the caret out of the field the person is still typing in.
 */
export function PaymentsToolbar({
  scope,
  search,
  needsConfirmCount,
  t,
}: {
  scope: PaymentsScope;
  search: string;
  /**
   * Transfers the student has marked sent and she has not confirmed — the only
   * count on this screen that is a JOB. Deliberately not "how many pending",
   * which is a number the list under the tab already prints and which she can
   * do nothing about while the student still has the ball.
   */
  needsConfirmCount: number;
  t: TFunction;
}) {
  const SCOPE_LABEL: Record<PaymentsScope, string> = {
    all: t("web.payments.view.all"),
    pending: t("web.payments.view.pending"),
    paid: t("web.payments.view.paid"),
    refunded: t("web.payments.view.refunded"),
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      {/* `overflow-x-auto` rather than wrapping: four short labels fit every
          viewport this ships to, and a scroller keeps them on one line if a
          translation or a raised text size makes them not. */}
      <nav
        aria-label={t("web.payments.views.label")}
        className="bg-muted -mx-1 flex gap-1 self-start overflow-x-auto rounded-md p-1"
      >
        {PAYMENTS_SCOPES.map((value) => {
          const active = value === scope;
          return (
            <Link
              key={value}
              href={paymentsHref(value, search)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                active
                  ? "bg-background text-foreground shadow-brand-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {SCOPE_LABEL[value]}
              {value === "pending" && needsConfirmCount > 0 && (
                <Badge variant="warning">{needsConfirmCount}</Badge>
              )}
            </Link>
          );
        })}
      </nav>

      <form method="get" className="flex items-center gap-2">
        {/* Carries the current view across a search, so searching from "Paid"
            searches the paid ones rather than silently dropping back to all. */}
        {scope !== "all" && <input type="hidden" name="show" value={scope} />}
        <div className="relative min-w-0 flex-1 lg:w-64 lg:flex-none">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            name="q"
            defaultValue={search}
            aria-label={t("web.payments.search.label")}
            placeholder={t("web.payments.search.placeholder")}
            className="pl-9"
          />
        </div>
        {/* Default size, not `sm`: `Input` is h-11/h-10 and a `sm` button is
            h-10/h-9, so the control beside the field would sit four pixels
            short of it on every viewport. */}
        <Button type="submit" variant="secondary">
          {t("web.payments.search.submit")}
        </Button>
        {search && (
          <Button asChild variant="ghost">
            <Link href={paymentsHref(scope)}>{t("web.payments.search.clear")}</Link>
          </Button>
        )}
      </form>
    </div>
  );
}
