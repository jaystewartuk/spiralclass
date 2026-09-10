"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/components/locale-provider";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "bg-foreground/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 backdrop-blur-xs",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** Where the dialog sits, and therefore how it animates in. */
export type DialogPlacement = "center" | "sheet";

const dialogPlacementClass: Record<DialogPlacement, string> = {
  // Centred modal — the right shape for short, focused dialogs (confirmations,
  // a single field). Unchanged from before `placement` existed, and the default.
  center:
    "w-dialog-inset left-1/2 top-1/2 grid max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg p-6 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
  // Bottom sheet on phones, the same centred modal from `sm` up. Anything with
  // a real form in it belongs here: a vertically-centred modal on a 360px-wide
  // phone either overflows the viewport or — because the platform sheet it gets
  // compared against is bottom-anchored — strands its own actions a thumb-reach
  // away from where they are expected. `max-h`/`overflow-y-auto` keep a long
  // form scrolling INSIDE the sheet, so the header and footer stay put.
  //
  // The slide is declared unprefixed and RESET at `sm` (…-from-bottom-0) rather
  // than scoped with `max-sm:`, because this config generates no `max-*`
  // variants at all — `theme.screens` carries `raw` entries (breakpoints.ts),
  // which switches Tailwind's max-width variant generation off. A `max-sm:`
  // class here compiles to nothing, silently. tests/config/tailwind-variants
  // .test.ts pins that.
  sheet:
    "max-h-sheet inset-x-0 bottom-0 flex flex-col gap-4 overflow-y-auto rounded-t-2xl border-b-0 p-5 pb-safe-bottom data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom sm:max-h-sheet-desktop sm:w-dialog-inset sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border-b sm:p-6 sm:pb-6 sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=open]:zoom-in-95",
};

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Hide the default close (X) button — e.g. for alert dialogs. */
    hideClose?: boolean;
    placement?: DialogPlacement;
  }
>(({ className, children, hideClose, placement = "center", ...props }, ref) => {
  const t = useT();
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "border-border bg-card text-card-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed z-50 border shadow-lg duration-200",
          dialogPlacementClass[placement],
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="text-muted-foreground ring-offset-background hover:text-foreground focus-visible:ring-ring absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-hidden focus-visible:ring-3 focus-visible:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">{t("common.close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 text-left", className)} {...props} />;
}
DialogHeader.displayName = "DialogHeader";

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 lg:flex-row lg:justify-end", className)}
      {...props}
    />
  );
}
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("font-display text-lg leading-none font-semibold", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-muted-foreground text-sm", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
