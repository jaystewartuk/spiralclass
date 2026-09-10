"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";

// Matches the shape every teacher-preference server action already returns
// (`ProfileState`), so a callable action is assignable without a cast.
export type ToggleState = { ok?: boolean; error?: string } | undefined;

/**
 * A single on/off preference that saves itself.
 *
 * Replaces two hand-rolled copies (auto-surface materials, auto-record
 * classes) that shared a shape and a pair of defects:
 *
 * 1. **They could not be turned off.** Both mirrored the Radix checkbox into
 *    `<input type="hidden" value={enabled ? "on" : ""}>`, and a hidden input
 *    always submits — so `formData.get(name)` returned `""`, never `null`, and
 *    the actions (which read PRESENCE, exactly as their tests assert) saw
 *    "on" every time. Once a teacher enabled auto-recording she had no way
 *    back from this page. Here the field is simply ABSENT when off, which is
 *    what an unchecked checkbox posts and what the action expects.
 * 2. **The checkbox had no accessible name.** A wrapping `<label>` does not
 *    name the `<button role="checkbox">` Radix renders; `htmlFor`/`id` does
 *    (a button is a labelable element), and it also makes the words clickable.
 *
 * It saves on the toggle rather than behind a Save button. A single boolean
 * has nothing to review before committing, and the "did that save?" question
 * a stray Save button leaves behind is answered by the status line instead.
 * The optimistic state reverts if the action comes back with an error.
 */
export function ToggleSetting({
  name,
  action,
  initialEnabled,
  label,
  hint,
  savingLabel,
  savedLabel,
}: {
  /** Form field the server action reads. Posted only when on. */
  name: string;
  action: (state: ToggleState, formData: FormData) => Promise<ToggleState>;
  initialEnabled: boolean;
  label: string;
  hint?: string;
  savingLabel: string;
  savedLabel: string;
}) {
  const id = useId();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [state, formAction, pending] = useActionState<ToggleState, FormData>(action, undefined);
  // What the server last accepted, and what the in-flight save is trying to
  // make true — so a rejected save can put the switch back where it was.
  const committed = useRef(initialEnabled);
  const attempted = useRef(initialEnabled);

  useEffect(() => {
    if (!state) return;
    if (state.error) setEnabled(committed.current);
    else committed.current = attempted.current;
  }, [state]);

  function toggle(next: boolean) {
    attempted.current = next;
    setEnabled(next);
    const formData = new FormData();
    // Absent means off. See the note above — this is the whole bug fix.
    if (next) formData.set(name, "on");
    startTransition(() => formAction(formData));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={enabled}
          disabled={pending}
          onCheckedChange={(v) => toggle(v === true)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="mt-1"
        />
        <div className="min-w-0 space-y-1">
          <Label htmlFor={id} className="leading-snug font-medium">
            {label}
          </Label>
          {hint ? (
            <p id={`${id}-hint`} className="text-sm text-muted-foreground">
              {hint}
            </p>
          ) : null}
        </div>
      </div>
      <FormStatus
        state={state}
        pending={pending}
        savingMessage={savingLabel}
        savedMessage={savedLabel}
      />
    </div>
  );
}
