import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function StatusPill({
  tone,
  label,
  pulse,
  onActivate,
}: {
  tone: "attention" | "warning" | "recording" | "info";
  label: string;
  pulse?: boolean;
  onActivate?: () => void;
}) {
  const toneClass = {
    // "attention" is the light-on-dark inversion — it is the loudest thing
    // available on a black stage, which is right for the messages that are
    // asking the user to DO something.
    attention: "bg-background text-foreground",
    warning: "bg-warning text-warning-foreground",
    recording: "bg-destructive text-destructive-foreground",
    info: "bg-info text-info-foreground",
  }[tone];
  // Only the interactive variant needs these. <Button variant="ghost"> brings
  // its own neutral hover fill, which would repaint a coloured pill grey the
  // moment a pointer touched it, so each tone states how IT reacts instead of
  // inheriting a hover meant for a page-background control.
  const toneInteractiveClass = {
    attention: "hover:bg-background/90 hover:text-foreground active:bg-background/80",
    warning: "hover:bg-warning/90 hover:text-warning-foreground active:bg-warning/80",
    recording: "hover:bg-destructive/90 hover:text-destructive-foreground active:bg-destructive/80",
    info: "hover:bg-info/90 hover:text-info-foreground active:bg-info/80",
  }[tone];
  const body = (
    <>
      {pulse && (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full bg-current motion-safe:animate-pulse"
        />
      )}
      {label}
    </>
  );
  const shape = cn(
    "flex max-w-md items-center gap-2 rounded-full px-3.5 py-1.5 text-center text-sm font-medium shadow-lg",
    toneClass,
  );
  if (onActivate) {
    // A button, not a role="status" div: the label is the accessible name of
    // the thing that fixes it, so a screen-reader user gets one object to act
    // on instead of an announcement about a control that isn't there. The ui/
    // primitive rather than a bare <button> so the focus ring is the app's —
    // a keyboard user on a black stage has nothing else to go on. `h-auto` and
    // `whitespace-normal` undo the primitive's fixed control height and single
    // line, which a sentence-length pill needs.
    return (
      <Button
        type="button"
        variant="ghost"
        onClick={onActivate}
        className={cn(
          shape,
          toneInteractiveClass,
          // `lg:h-auto` as well as `h-auto`: the primitive's size sets a
          // breakpoint height too, and only a matching breakpoint class
          // displaces it — plain `h-auto` would leave the pill snapping to a
          // control's height on a laptop and hugging its text on a phone.
          "pointer-events-auto h-auto whitespace-normal lg:h-auto",
        )}
      >
        {body}
      </Button>
    );
  }
  return (
    <div
      // Announced once when it appears. Not aria-live="assertive": none of
      // these is urgent enough to cut across what the user is doing, and the
      // recording pill in particular is persistent, which assertive would
      // turn into a repeated interruption.
      role="status"
      className={shape}
    >
      {body}
    </div>
  );
}
