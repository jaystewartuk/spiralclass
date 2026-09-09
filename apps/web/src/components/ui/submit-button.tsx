"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Drop-in `<Button type="submit">` for forms whose `action` is a plain
// server action (not `useActionState`) — those forms have no client-side
// pending signal of their own, so a tap gave zero visible feedback until the
// server round-trip finished (from the pilot teacher's product issues: rage-clicks on
// the Library's archive/delete row actions). `useFormStatus` reads the
// pending state of the nearest ancestor <form>, so this only works when
// rendered inside one.
export function SubmitButton({ children, className, disabled, ...props }: ButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending} className={cn(className)} {...props}>
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}
