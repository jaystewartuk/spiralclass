"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loadConnectAndInitialize } from "@stripe/connect-js";
import { ConnectAccountOnboarding, ConnectComponentsProvider } from "@stripe/react-connect-js";
import { startEmbeddedConnectOnboarding } from "@/app/actions/stripe-connect";

// The instance type isn't re-exported from the package root, so derive it
// rather than importing from @stripe/connect-js/dist/*.
type ConnectInstance = ReturnType<typeof loadConnectAndInitialize>;

// Stripe Connect embedded onboarding — renders the same first-time-KYC /
// re-verification flow that startStripeConnect's Account Link would have
// redirected to, inline in this page instead. Same trigger point (this
// screen), same country gate, same account-creation logic — only the
// rendering technology (embedded iframe vs. hosted-page redirect) differs.
// Only mounted when hasStripeEmbeddedCheckout() is true (see page.tsx);
// otherwise the page falls back to the existing <form action=...> buttons.
export function StripeConnectEmbeddedOnboarding({ publishableKey }: { publishableKey: string }) {
  const router = useRouter();
  const [connectInstance, setConnectInstance] = useState<ConnectInstance | null>(null);

  // Initialization is deliberately in an effect, NOT in render (it was a
  // `useMemo` until 2026-08-31). loadConnectAndInitialize invokes
  // fetchClientSecret eagerly, and fetchClientSecret calls a Server Function
  // — from inside useMemo that happens *during* the initial render, which
  // Next.js rejects outright: "Server Functions cannot be called during
  // initial render. This would create a fetch waterfall." It threw on every
  // mount of this component (Sentry AGENDAPROFE-30/-2Z, 83 events in a day),
  // so the onboarding card never initialized at all. An effect runs after
  // commit, where calling a Server Function is legal.
  //
  // The ref guard makes this exactly-once per mounted component. That is not
  // a nicety: fetchClientSecret reaches ensureConnectedAccount, which CREATES
  // A LIVE STRIPE ACCOUNT, and a created account can never be deleted or
  // closed by the platform (D-143 / PR 948 — 24 permanent orphan accounts came
  // from exactly this component retrying). React StrictMode double-invokes
  // effects in development, so without the guard the dev flow alone would
  // initialize twice. `connect-account-<teacherId>` idempotency on the server
  // is the other half of that belt-and-braces; neither is optional.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setConnectInstance(
      loadConnectAndInitialize({
        publishableKey,
        fetchClientSecret: async () => {
          const result = await startEmbeddedConnectOnboarding();
          if ("clientSecret" in result) return result.clientSecret;
          // "connected" (dev-stub path, already fully onboarded) or "error"
          // — neither yields a client_secret. Surfacing as a load error
          // (Connect.js calls onLoadError) is more useful than leaving the
          // component stuck retrying indefinitely.
          throw new Error("error" in result ? result.error : "already-connected");
        },
      }),
    );
    // publishableKey is a build-time value threaded down from the Server
    // Component and never changes for a mounted instance; re-initializing on
    // a change would mean minting against a different platform account, which
    // is a redeploy, not a re-render.
  }, [publishableKey]);

  // First paint, before the effect has run. A plain reserved box rather than
  // null so the card doesn't visibly jump when the iframe mounts.
  if (!connectInstance) {
    return <div className="bg-muted/40 h-64 animate-pulse rounded-md" aria-hidden />;
  }

  return (
    <ConnectComponentsProvider connectInstance={connectInstance}>
      <ConnectAccountOnboarding
        onLoadError={({ error }) => {
          // fetchClientSecret rethrows the server action's error code as the
          // Error message, and this is where it lands. Without this handler
          // the card just sits empty and the teacher is told nothing — which
          // is precisely how the CSP failure went unnoticed until it had
          // minted 24 permanent accounts (PR 948). Reflect the code back as the
          // page's own ?error= banner so it renders real copy.
          //
          // Only the codes the page has copy for are forwarded; anything else
          // (a genuine Connect.js network failure) falls through to the
          // generic banner rather than putting an opaque string in the URL.
          const code = error?.message;
          const known = code === "account-unreachable" || code === "country-unsupported";
          router.replace(`/settings/payments?error=${known ? code : "generic"}`);
        }}
        onExit={() => {
          // account.updated (the existing webhook) is the source of truth
          // for stripeChargesEnabled/stripePayoutsEnabled — refresh the
          // Server Component so the status card above reflects whatever
          // just changed, same as the return-URL redirect flow does today.
          router.refresh();
        }}
      />
    </ConnectComponentsProvider>
  );
}
