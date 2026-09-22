"use client";

import { useActionState, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/components/locale-provider";
import type { FeedActionState } from "@/app/actions/calendar-feed";

// Shows the read-only subscription URL with copy + regenerate, plus a short
// how-to. Used on the teacher Settings → Calendar page and the student account
// page. The `regenerateAction` is a server action passed in by the page.
export function CalendarSyncPanel({
  feedUrl,
  regenerateAction,
}: {
  feedUrl: string;
  regenerateAction: (prev: FeedActionState, formData: FormData) => Promise<FeedActionState>;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [, formAction, pending] = useActionState(regenerateAction, undefined);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions) — the input is
      // selectable, so the user can still copy manually.
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          readOnly
          value={feedUrl}
          onFocus={(e) => e.currentTarget.select()}
          // Named for a screen reader, which otherwise announces "edit text"
          // and reads out a 100-character token URL with nothing saying what it
          // is for. axe rates an unlabelled form field `critical`, and it was
          // one on both pages this panel serves until /my-classes/account
          // entered the a11y sweep. The nearest visible text is the section
          // heading, which says only "Calendar" — enough for someone who can
          // see the Copy button beside the field, and not enough for someone
          // who cannot.
          aria-label={t("web.calendarSync.feedUrlLabel")}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" onClick={copy} className="shrink-0">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span className="ml-1.5">{copied ? t("common.copied") : t("common.copy")}</span>
        </Button>
      </div>

      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">{t("web.calendarSync.howTo.title")}</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>{t("web.calendarSync.howTo.google")}</li>
          <li>{t("web.calendarSync.howTo.apple")}</li>
          <li>{t("web.calendarSync.howTo.outlook")}</li>
        </ul>
        <p className="mt-2">{t("web.calendarSync.howTo.privacyNote")}</p>
      </div>

      <form action={formAction}>
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-muted-foreground"
        >
          {pending ? t("web.calendarSync.resetting") : t("web.calendarSync.resetLink")}
        </Button>
      </form>
    </div>
  );
}
