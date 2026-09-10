"use client";

import { useMemo, useState } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import Link from "next/link";
import { ChevronLeft, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PersonAvatar } from "@/components/teacher-identity";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type Recipient = { id: string; name: string };

// Client picker for starting a new conversation from the Messages tab. The
// server page resolves the roster (teacher → students, or student → teachers)
// and hands it here; each row links into the existing conversation route, which
// already renders fine with zero messages. Search filters client-side so a
// teacher with a long roster can find someone fast.
export function RecipientPicker({
  title,
  subtitle,
  backHref,
  hrefBase,
  recipients,
  searchPlaceholder,
  emptyLabel,
  noMatchLabel,
}: {
  title: string;
  subtitle: string;
  backHref: string;
  /** Conversation route prefix; the row links to `${hrefBase}/${id}`. */
  hrefBase: string;
  recipients: Recipient[];
  searchPlaceholder: string;
  emptyLabel: string;
  noMatchLabel: string;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recipients;
    return recipients.filter((r) => r.name.toLowerCase().includes(q));
  }, [query, recipients]);

  return (
    <PageShell width="reading">
      <div className="space-y-1">
        <Link
          href={backHref}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          {title}
        </Link>
        <PageHeader title={title} />
        <p className="text-muted-foreground text-sm">{subtitle}</p>
      </div>

      {recipients.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-16 text-center text-sm">
            {emptyLabel}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="pl-9"
              aria-label={searchPlaceholder}
            />
          </div>

          {filtered.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">{noMatchLabel}</p>
          ) : (
            <Card>
              <CardContent className="p-0">
                <ul className="divide-border divide-y">
                  {filtered.map((r, i) => (
                    <li key={r.id}>
                      <Link
                        href={`${hrefBase}/${r.id}`}
                        className={cn(
                          "hover:bg-muted/50 flex items-center gap-3 px-4 py-3.5 transition-colors",
                          i === 0 && "rounded-t-lg",
                          i === filtered.length - 1 && "rounded-b-lg",
                        )}
                      >
                        {/* The shared avatar, which this row was a third copy
                            of — same monogram, same 40px, and the same
                            `bg-primary/10 text-primary` tint PersonAvatar and
                            the Badge variants were migrated off. Two initials
                            rather than one now, because that is what every
                            other avatar in the app shows a name as. */}
                        <PersonAvatar name={r.name} />
                        <span className="truncate text-sm font-medium">{r.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </PageShell>
  );
}
