import { forwardRef, type AnchorHTMLAttributes } from "react";

// A plain <a> — deliberately NOT next/link — for the booking calendar's
// same-page, search-param-only navigations (day-grid cells, month
// prev/next chevrons, the credit-pool switcher, both "next available day"
// CTAs on /my-classes/book and /my-classes/[bookingId]/reschedule).
//
// On this route shape (an async Server Component reading `searchParams`,
// with a sibling `loading.tsx` — see vercel/next.js#53543,
// vercel/next.js#49297 for related App Router reports), a client-side
// transition can swap in the new day's content without ever committing the
// matching History entry: confirmed via trace inspection that the RSC fetch
// completes and the DOM changes, but the browser URL stays put. This first
// surfaced 2026-07-23 once the E2E gate (promote-only) finally ran again
// after being gated out by earlier failures for 17 days straight, and
// reproduced identically whether the click went through next/link's own
// handler OR an explicit router.push() call — both route through the exact
// same App Router internals, so neither sidesteps it.
//
// A native <a> can't have this problem: with no onClick interception, the
// click is a real browser navigation (full page load), which is atomic by
// construction — the URL the browser ends up on IS the document it rendered.
// These are low-frequency clicks (picking a day), so the lost SPA-transition
// smoothness costs nothing that matters here.
// forwardRef so it composes with Radix Slot (Button asChild) the same as
// next/link does.
export const HardLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  function HardLink(props, ref) {
    return <a ref={ref} {...props} />;
  },
);
