"use client";

import { LogOut } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/app/actions/auth";

// Sign-out control that also resets the browser posthog-js identity before
// the server action clears the session. reset() drops the current
// distinct_id so the next (anonymous) visitor on this device doesn't inherit
// the signed-out user's Person / session replay.
//
// Full-width by design: it is the last row of a menu, and a short button
// floating in a full-width list reads as a stray control rather than the end
// of the list. The icon is the second cue — signing out is the one
// irreversible thing in the menu and should not look like its neighbours.
export function SignOutButton({ label, className }: { label: string; className?: string }) {
  const posthog = usePostHog();
  return (
    <form action={signOutAction} onSubmit={() => posthog?.reset()} className={className}>
      <Button type="submit" variant="outline" className="w-full">
        <LogOut aria-hidden className="h-4 w-4" />
        {label}
      </Button>
    </form>
  );
}
