"use client";

import { PenLine, Paperclip, Sparkles } from "lucide-react";
import { ProLockNote } from "@/components/subscriptions/pro-lock-note";
import { useT } from "@/components/locale-provider";

// Entry step for creating a library material (UX redesign): three focused
// sub-flows instead of one dense form. Each maps to an existing content kind
// (body / body / storagePath+linkUrl) — no new "type" field, no schema change.
export type MaterialCreateMode = "ai" | "manual" | "upload";

export function MethodPicker({
  aiEnabled,
  isPro,
  onSelect,
}: {
  // Platform-wide AI credentials — with none configured, the AI card has
  // nothing to call, so it's omitted entirely (not just disabled).
  aiEnabled: boolean;
  // Teacher's own plan — Pro gates the actual generate/refine calls; a Free
  // teacher still sees the card (discoverability) with an inline upsell.
  isPro: boolean;
  onSelect: (mode: MaterialCreateMode) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("web.materials.method.title")}</p>
      <div className="grid gap-3">
        {aiEnabled && (
          <button
            type="button"
            onClick={() => onSelect("ai")}
            className="flex flex-col gap-1 rounded-lg border-2 border-primary/40 bg-primary/5 p-4 text-left transition-colors hover:border-primary"
          >
            <span className="flex items-center gap-2 font-medium">
              <Sparkles className="size-4 text-primary" aria-hidden />
              {t("web.materials.method.aiTitle")}
              <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-sm font-semibold text-primary-foreground">
                {t("web.materials.method.aiBadge")}
              </span>
            </span>
            <span className="text-sm text-muted-foreground">
              {t("web.materials.method.aiDescription")}
            </span>
            {!isPro && <ProLockNote message={t("classContent.author.proRequired")} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => onSelect("manual")}
          className="flex flex-col gap-1 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50"
        >
          <span className="flex items-center gap-2 font-medium">
            <PenLine className="size-4" aria-hidden />
            {t("web.materials.method.manualTitle")}
          </span>
          <span className="text-sm text-muted-foreground">
            {t("web.materials.method.manualDescription")}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onSelect("upload")}
          className="flex flex-col gap-1 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50"
        >
          <span className="flex items-center gap-2 font-medium">
            <Paperclip className="size-4" aria-hidden />
            {t("web.materials.method.uploadTitle")}
          </span>
          <span className="text-sm text-muted-foreground">
            {t("web.materials.method.uploadDescription")}
          </span>
        </button>
      </div>
    </div>
  );
}
