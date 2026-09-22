"use client";

import { Button } from "@/components/ui/button";

// A plain reload — during maintenance there's no better destination than
// re-requesting the current URL, which re-runs the middleware gate and drops
// the user back into the app the moment maintenance is lifted.
export function RetryButton({ label }: { label: string }) {
  return (
    <Button size="lg" onClick={() => window.location.reload()}>
      {label}
    </Button>
  );
}
