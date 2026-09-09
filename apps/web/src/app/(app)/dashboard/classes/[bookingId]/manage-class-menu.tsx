"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useT } from "@/components/locale-provider";

// Header "Manage class" affordance (class-detail redesign brief,
// docs/features/classes-lesson-content.md). Wraps the same
// `<OverrideAction>` elements the page used to render inline at the bottom of
// the screen — passed in as children from the server component — so the
// server-action gating and per-status preconditions in page.tsx are
// completely unchanged; this component only relocates where they render.
// Each OverrideAction owns its own nested confirm dialog (Radix Dialog
// portals nest fine), so this outer dialog just lists the triggers.
export function ManageClassMenu({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("web.dashboard.classes.detail.manage")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("web.dashboard.classes.detail.manage")}</DialogTitle>
          <DialogDescription>{t("web.dashboard.classes.detail.actionsHelp")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-start gap-3">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
