// The `beforeinstallprompt` event, held somewhere a component can still find it.
//
// WHY THIS IS A MODULE AND NOT A `useEffect`. Chrome fires the event ONCE, on
// its own schedule, shortly after a page load — and the whole point of it is
// that a listener registered later gets nothing. A component mounting on a
// client-side navigation into Settings is exactly "later": the event fired on
// whatever page the reader loaded first, and by the time the settings route's
// chunk is evaluated it is long gone.
//
// So capture starts once, from the root layout, and the settings row reads
// what was captured. The store is deliberately framework-free — module state
// and a callback set, not a context — because the value's lifetime is the tab's
// and not any React tree's.

/** The Chromium-only event. Not in lib.dom, so it is declared here. */
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let capturing = false;
const listeners = new Set<() => void>();

function announce() {
  for (const listener of listeners) listener();
}

/**
 * Begin holding on to the install prompt. Idempotent — the root layout calls
 * it on mount, and calling it again from anywhere is a no-op rather than a
 * second listener.
 */
export function startCapturingInstallPrompt(): void {
  if (capturing || typeof window === "undefined") return;
  capturing = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Without this, Chrome shows its own mini-infobar and the deferred event
    // is never usable. Preventing it is what makes the prompt ours to place.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    announce();
  });

  // Fired when the install completes — by our button or by the browser's own
  // menu, which is why the button cannot just trust its own return value.
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    announce();
  });
}

/** Subscribe to changes. Returns the unsubscribe. */
export function onInstallPromptChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once a one-tap install is available on this page. */
export function hasInstallPrompt(): boolean {
  return deferred !== null;
}

/** True once this tab has seen the app installed. */
export function wasInstalled(): boolean {
  return installed;
}

/**
 * Already running as an installed app? Then there is nothing to offer.
 *
 * `display-mode: standalone` covers Android and desktop; `navigator.standalone`
 * is Safari's non-standard flag and remains the only signal on iOS. Both are
 * checked in web-push-toggle.tsx for the same reason — an iOS reader who has
 * already installed must not be told to install again.
 */
export function isRunningStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Show the install prompt. Resolves to whether the reader accepted.
 *
 * The event is single-use: Chrome refuses a second `prompt()` on the same
 * event, so it is dropped either way and the affordance goes with it. A
 * dismissal is not an error and must not read as one.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred;
  if (!event) return "unavailable";
  deferred = null;
  announce();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return "dismissed";
  }
}

/** Test seam: forget everything this module is holding. */
export function resetInstallPromptForTests(): void {
  deferred = null;
  installed = false;
  capturing = false;
  listeners.clear();
}

/** Test seam: hand the store an event without a real browser. */
export function captureInstallPromptForTests(event: BeforeInstallPromptEvent): void {
  deferred = event;
  announce();
}
