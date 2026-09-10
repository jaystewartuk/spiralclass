"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

/**
 * The call control row's drawer handle — web parity with mobile's
 * `controlsCollapsed` (see `NativeCall.tsx`). Both a teacher and a student can
 * pull the whole bottom control row out of the way mid-class and bring it back.
 *
 * Manual, never on a timer. Web used to fade the controls out on inactivity and
 * that behaviour was deliberately removed (see the control-row comment in
 * `class-call.tsx`); this restores a way to reclaim the strip WITHOUT
 * reintroducing chrome that hides itself out from under someone mid-sentence.
 * Mobile made the same call for its own reason (an auto-hide raced every
 * Maestro flow's tap steps), so the two platforms agree: the row only moves
 * when a person asks it to.
 *
 * Unlike mobile, the row is NOT unmounted while collapsed — it is hidden with
 * the `hidden` attribute, which takes it out of the layout AND out of the
 * accessibility tree while leaving the children's own state alone (the
 * teacher's materials panel holds open-sheet state that a remount would drop).
 * Also unlike mobile, there is no auto-collapse when a material takes over the
 * stage: that exists to buy back a phone's scarce vertical strip, and on a
 * laptop it would silently take the mic and Leave buttons away from a teacher
 * who only opened a worksheet.
 */
export function CallControlsDrawer({ children }: { children: ReactNode }) {
  const t = useT();
  // Defaults to expanded — nothing hides until someone asks it to.
  const [collapsed, setCollapsed] = useState(false);
  const rowId = useId();
  const label = collapsed ? t("call.showControls") : t("call.hideControls");

  return (
    <>
      {/* The handle is NEVER conditional: collapsing hides the entire row —
      Leave included, same as mobile — so this is the only route back to it.
      Always mounted, always bottom-centre. */}
      <div className={cn("flex justify-center pt-2", collapsed && "pb-4")}>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={label}
          title={label}
          aria-expanded={!collapsed}
          aria-controls={rowId}
          className={cn(
            "flex items-center justify-center rounded-full text-white transition-all",
            collapsed
              ? // Wider and brighter once collapsed, because at that point it is
                // the only call chrome left on screen. A faint 15%-white sliver
                // floating over a material reads as an artifact; this reads as a
                // handle.
                "border-overlay-3 bg-scrim-2 hover:bg-scrim-3 h-7 w-20 border backdrop-blur-md"
              : "bg-overlay-1 hover:bg-overlay-2 h-[22px] w-11",
          )}
        >
          {collapsed ? (
            <ChevronUp className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
      <div id={rowId} hidden={collapsed}>
        {children}
      </div>
    </>
  );
}
