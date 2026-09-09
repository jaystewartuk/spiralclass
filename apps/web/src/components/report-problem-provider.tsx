"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ReportProblemDialog } from "@/components/report-problem-dialog";

// One "Report a problem" dialog for the whole app, mounted at the root layout
// beside <CallSessionOverlay> and for the same reason: the thing that OPENS it
// is inside a menu that unmounts.
//
// The entry points are the desktop account dropdown and the mobile nav drawer,
// and both dismiss themselves on any pointerdown outside their own container.
// The dialog renders through a portal, so every click inside it is "outside"
// the menu — a dialog owned by the menu button would be torn down by the user's
// first interaction with it, mid-report. Hoisting ownership here also means a
// route change (which closes both menus) leaves a half-written report standing.
type ReportProblemContextValue = { openReportProblem: () => void };

const ReportProblemContext = createContext<ReportProblemContextValue | null>(null);

export function ReportProblemProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openReportProblem = useCallback(() => setOpen(true), []);
  const value = useMemo(() => ({ openReportProblem }), [openReportProblem]);

  return (
    <ReportProblemContext.Provider value={value}>
      {children}
      <ReportProblemDialog open={open} onOpenChange={setOpen} />
    </ReportProblemContext.Provider>
  );
}

/** Null outside the provider — the caller falls back to its own dialog instance
 * rather than rendering a button that silently does nothing. */
export function useReportProblem(): ReportProblemContextValue | null {
  return useContext(ReportProblemContext);
}
