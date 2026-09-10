"use client";

import { EMOJI_CATALOG } from "@spiralclass/shared";
import type { TFunction } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { emojiCategoryLabel } from "@/lib/chat/labels";

/**
 * The full emoji grid, in a dialog rather than a floating panel.
 *
 * It used to be a 256px `absolute` panel anchored to whichever button opened
 * it. Inside the message list — an `overflow-y-auto` column — that panel was
 * clipped by the scroll box for any message not near the middle of the screen,
 * and on a phone it covered the composer it was attached to. A dialog is
 * portalled out of the scroll container, focus-trapped, dismissible with
 * Escape, and sized to the viewport, which is all four problems at once.
 *
 * The quick-reaction row stays a popover: six emoji is a 52px strip that fits
 * anywhere, and reacting is meant to cost one tap.
 */
export function EmojiPickerDialog({
  open,
  onOpenChange,
  onSelect,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (emoji: string) => void;
  t: TFunction;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-over-stage flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 pt-5 pb-4">
          <DialogTitle>{t("chat.emoji.open")}</DialogTitle>
          <DialogDescription>{t("chat.react.more")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5">
          {EMOJI_CATALOG.map((category) => (
            <section key={category.key} aria-label={emojiCategoryLabel(t, category.key)}>
              <h3 className="sticky top-0 z-10 bg-card px-2 py-2 text-sm font-semibold text-muted-foreground">
                {emojiCategoryLabel(t, category.key)}
              </h3>
              <div className="grid grid-cols-6 gap-1 pb-2 lg:grid-cols-8">
                {category.emoji.map((emoji) => (
                  <Button
                    key={emoji}
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={emoji}
                    className="text-xl"
                    onClick={() => {
                      onSelect(emoji);
                      onOpenChange(false);
                    }}
                  >
                    <span aria-hidden>{emoji}</span>
                  </Button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
