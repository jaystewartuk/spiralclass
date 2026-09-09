"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { NavRowIcon, NavRowLabel, type NavRowDensity } from "@/components/nav/nav-row";
import { ReportProblemDialog } from "@/components/report-problem-dialog";
import { useReportProblem } from "@/components/report-problem-provider";

// The "Report a problem" entry in the account menu (desktop) and the nav drawer
// (mobile). It owns nothing but the request to open; the form is
// report-problem-dialog.tsx and normally lives at the root layout
// (report-problem-provider.tsx) so it outlives the menu this button sits in.
//
// It used to hand its own DOM node to Sentry's `feedbackIntegration` via
// attachTo(), which rendered the SDK's dialog into a shadow root. That dialog is
// gone — the note at the top of report-problem-dialog.tsx says what it cost us —
// but the call sites keep the same `label`/`className` props. It stays a plain
// <button> taking a caller-supplied className so it goes on sitting among
// ordinary menu rows instead of bringing a Button variant into a list of links.
export function ReportProblemButton({
  label,
  className,
  // Lets the menu containing this entry close itself as the dialog opens,
  // instead of sitting open behind the modal.
  onOpen,
  icon: Icon,
  density,
}: {
  label: string;
  className?: string;
  onOpen?: () => void;
  icon?: LucideIcon;
  // Matches the row density of the menu it is in — the same 20px/16px split
  // every other nav row uses, so this entry lines up with its neighbours
  // rather than being the one row with its own spacing.
  density?: NavRowDensity;
}) {
  const shared = useReportProblem();
  const [localOpen, setLocalOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          if (shared) shared.openReportProblem();
          else setLocalOpen(true);
          onOpen?.();
        }}
      >
        <NavRowIcon icon={Icon} density={density} />
        <NavRowLabel>{label}</NavRowLabel>
      </button>
      {!shared && <ReportProblemDialog open={localOpen} onOpenChange={setLocalOpen} />}
    </>
  );
}
