"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type ConfirmDialogProps = {
  /** The element that opens the dialog (rendered via asChild). */
  trigger: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /**
   * Body content rendered between the header and footer — e.g. a reason
   * textarea, a penalty warning, or extra context.
   */
  children?: React.ReactNode;
  /** Footer content (confirm/cancel buttons). Receives a `close` helper. */
  footer: (close: () => void) => React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Accessible confirmation dialog (role="alertdialog") with focus trap,
 * return-focus and Escape-to-cancel handled by Radix Dialog.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  children,
  footer,
  open,
  onOpenChange,
}: ConfirmDialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent role="alertdialog" hideClose>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>{footer(() => setOpen(false))}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
