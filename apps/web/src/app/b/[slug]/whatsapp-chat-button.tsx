"use client";

import { MessageCircle } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { whatsAppChatUrl } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";

// "Chat on WhatsApp" on the public booking page — a plain wa.me deep-link
// (D-42: no Meta Cloud API involved, same kind of link as the "share your
// booking link" / support buttons elsewhere in the app), shown only when the
// teacher opted a number in via Settings → Booking page. Pre-fills a short
// intro message so the teacher opens the chat already knowing which page the
// student came from.
export function WhatsAppChatButton({
  whatsappE164,
  teacherName,
  teacherId,
  slug,
  message,
  label,
  variant = "outline",
}: {
  whatsappE164: string;
  teacherName: string;
  teacherId: string;
  slug: string;
  message: string;
  label: string;
  /** `default` where this is the card's leading offer (the packages card);
   * `outline` where it sits beside the lead form. */
  variant?: "default" | "outline";
}) {
  const posthog = usePostHog();
  const url = whatsAppChatUrl(whatsappE164, message);
  if (!url) return null;

  return (
    <Button asChild variant={variant} className="w-full">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() =>
          posthog?.capture("whatsapp_contact_clicked", {
            teacher_id: teacherId,
            slug,
          })
        }
        aria-label={`${label} — ${teacherName}`}
      >
        <MessageCircle className="h-4 w-4" aria-hidden />
        {label}
      </a>
    </Button>
  );
}
