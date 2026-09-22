"use client";

import { useEffect } from "react";

import { startCapturingInstallPrompt } from "@/lib/pwa/install-prompt";

/**
 * Renders nothing. Its whole job is to start listening for
 * `beforeinstallprompt` before the reader has navigated anywhere.
 *
 * It lives in the ROOT layout rather than beside the button that uses it
 * because Chrome fires that event once, early, and never again — a listener
 * registered when the settings route mounts is a listener that gets nothing on
 * every client-side navigation into it. See lib/pwa/install-prompt.ts.
 */
export function InstallPromptCapture() {
  useEffect(() => {
    startCapturingInstallPrompt();
  }, []);
  return null;
}
