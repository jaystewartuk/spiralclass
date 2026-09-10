"use client";

import type { MouseEvent, ReactNode } from "react";

import { Button } from "@/components/ui/button";

// Small icon-only ghost button — chrome shared by the section editor
// (material-editor.tsx) and the per-block editor one level down
// (block-editor.tsx, MATERIAL_EDITING phase 4): move/duplicate/delete on a
// section card, the same on a block. Its own file so the two editors don't
// import from each other.
export function IconButton({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  // The event is exposed so a caller nested inside another interactive
  // region (e.g. the read-mode block's delete) can stopPropagation.
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={
        destructive
          ? "text-muted-foreground hover:text-destructive px-1.5"
          : "text-muted-foreground px-1.5"
      }
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}
