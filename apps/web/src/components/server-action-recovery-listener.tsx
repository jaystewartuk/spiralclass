"use client";

import { useEffect } from "react";
import { recoverFromServerActionSkew } from "@/lib/server-action-recovery";

// Catches server-action version-skew errors that DON'T surface through a React
// error boundary — e.g. a server action invoked programmatically whose rejection
// goes unhandled, or one that React reports as a window error. Mounted once near
// the root of the tree (see app/layout.tsx). Boundary-caught skew errors are
// handled by useSkewRecoveryOrReport instead; the sessionStorage cooldown in
// recoverFromServerActionSkew keeps the two paths from double-reloading.
export function ServerActionRecoveryListener() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (recoverFromServerActionSkew(event.reason)) event.preventDefault();
    };
    const onError = (event: ErrorEvent) => {
      if (recoverFromServerActionSkew(event.error ?? event.message)) {
        event.preventDefault();
      }
    };

    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  return null;
}
