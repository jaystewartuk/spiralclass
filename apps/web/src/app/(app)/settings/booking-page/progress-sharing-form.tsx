"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FormStatus } from "@/components/ui/form-status";
import { ToggleField } from "@/components/ui/toggle-field";
import { useT } from "@/components/locale-provider";
import {
  setProgressSharingAction,
  type ProgressSharingState,
} from "@/app/actions/progress-sharing";

// Settings → Booking page → "Share progress with my students". A
// self-submitting toggle: flipping it posts immediately, no Save button,
// optimistic local state for feedback.
//
// Unlike the page's other toggles, this flip also rewrites every existing
// pairing (see the
// action), so the hint says so — a control with a wider blast radius than the
// label implies is the kind that gets flipped by accident. `ToggleField` wires
// that hint in as the control's accessible description, so it is read out
// rather than merely displayed next to it.
export function ProgressSharingForm({ initialShared }: { initialShared: boolean }) {
  const t = useT();
  const [shared, setShared] = useState(initialShared);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<ProgressSharingState, FormData>(
    setProgressSharingAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.shared ? t("web.progressSharing.on") : t("web.progressSharing.off"));
    }
  }, [state, t]);

  return (
    <form action={action} ref={formRef}>
      <ToggleField
        name="shared"
        checked={shared}
        onCheckedChange={(checked) => {
          setShared(checked);
          formRef.current?.requestSubmit();
        }}
        label={t("web.progressSharing.label")}
        hint={t("web.progressSharing.hint")}
        status={
          <FormStatus
            state={state}
            pending={pending}
            savingMessage={t("web.settings.saving")}
            savedMessage={t("bookingPage.saved")}
          />
        }
      />
    </form>
  );
}
