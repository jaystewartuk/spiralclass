"use client";

import { FileText } from "lucide-react";
import type { AppLocale, TFunction } from "@spiralclass/shared";
import { formatFileSize } from "@/lib/chat/view-model";
import { cn } from "@/lib/utils";

/** A document attachment: a labelled chip that downloads the signed URL, the
 * pattern WhatsApp uses instead of trying to preview arbitrary file types. */
export function FileMessage({
  fileUrl,
  fileName,
  sizeBytes,
  fromMe,
  locale,
  t,
}: {
  fileUrl: string;
  fileName: string | null;
  sizeBytes: number | null;
  fromMe: boolean;
  locale: AppLocale;
  t: TFunction;
}) {
  const name = fileName ?? t("chat.file.untitled");
  const size = formatFileSize(sizeBytes, locale);
  return (
    <a
      href={fileUrl}
      target="_blank"
      rel="noreferrer"
      download={fileName ?? undefined}
      aria-label={t("chat.file.download", { name })}
      className="flex min-w-attachment items-center gap-3 rounded-xl"
    >
      <span
        aria-hidden
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
          fromMe ? "bg-overlay-1" : "bg-muted",
        )}
      >
        <FileText className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium underline-offset-4 group-hover:underline">
          {name}
        </span>
        {size ? (
          <span
            className={cn(
              "block text-sm",
              fromMe ? "text-primary-foreground" : "text-muted-foreground",
            )}
          >
            {size}
          </span>
        ) : null}
      </span>
    </a>
  );
}
