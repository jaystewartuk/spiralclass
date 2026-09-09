import { NextResponse } from "next/server";
import { shareGroupSlug } from "@spiralclass/shared";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
  serializeAttribution,
  type Attribution,
} from "@/lib/analytics/attribution";
import { serverEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";

// The tracked acquisition link: /g/<code> -> the teacher's booking page.
//
// Why a redirect instead of `?utm_source=...&utm_medium=...&utm_content=...`
// hanging off the booking URL:
//
//   * A four-parameter tracking URL reads as an advertisement in a community
//     feed. That impression is what gets a post removed, and it is why
//     teachers were editing the parameters off by hand — which silently
//     destroyed the attribution the whole system depends on.
//   * One short link is one thing to copy, so the activity, the community and
//     the content kind are all pinned by a value the teacher cannot mangle.
//   * The visitor lands on a clean `/b/<slug>`. Nothing about the teacher's own
//     page advertises that it was reached through a tracked link.
//
// Everything downstream is unchanged: this stamps the SAME first-touch `ap_src`
// cookie the middleware would have written from UTM parameters, so the ledger,
// PostHog and the booking-page event all keep working exactly as before. Links
// posted before D-125 (plain `?utm_*`) therefore still attribute correctly.

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");

  // Charset-bounded before it reaches the database: this is an unauthenticated
  // path-segment from anyone on the internet.
  if (!/^[a-z0-9]{6,16}$/.test(code)) {
    return NextResponse.redirect(`${appUrl}/`, 302);
  }

  const activity = await prisma.marketingActivity.findUnique({
    where: { trackingCode: code },
    select: {
      id: true,
      teacherId: true,
      communityId: true,
      platform: true,
      teacher: { select: { bookingSlug: true, disabledAt: true } },
      // Only to decide whether the destination needs the group tag below —
      // `preview` is selected as a bare existence check, not read. Folded into
      // this query rather than added as a second round-trip on a redirect that
      // sits in front of every community click.
      community: { select: { id: true, name: true, preview: { select: { id: true } } } },
    },
  });

  // An unknown or retired code lands on the home page rather than a 404: the
  // link is already posted in a community and a dead end there is worse than a
  // soft landing.
  if (!activity || !activity.teacher.bookingSlug || activity.teacher.disabledAt) {
    return NextResponse.redirect(`${appUrl}/`, 302);
  }

  // The clean landing URL this route exists to produce — with ONE exception.
  //
  // A crawler scraping the posted `/g/<code>` follows this redirect and reads
  // the tags of whatever it lands on, so a destination with no group tag
  // resolves no group preview: the community's card (D-123) was unreachable
  // through a tracked link, which is the very link teachers are told to post.
  // Appending the tag when — and only when — that community actually has a
  // preview keeps the "nothing advertises that this was a tracked link"
  // property for every teacher who never configured one, which is most of them.
  // The posted link is untouched either way: it is still `/g/<code>`, one short
  // thing to copy, which is what the reads-as-an-advertisement rule above is
  // about.
  //
  // Attribution is unaffected: the cookie below is written on THIS response, so
  // the middleware sees a first touch already recorded when the browser follows
  // to the tagged URL and leaves `campaign=ap-<code>` in place rather than
  // re-deriving from the tag.
  const groupTag = activity.community?.preview
    ? `?utm_content=${encodeURIComponent(shareGroupSlug(activity.community))}`
    : "";
  const destination = `${appUrl}/b/${activity.teacher.bookingSlug}${groupTag}`;
  const response = NextResponse.redirect(destination, 302);

  const attribution: Attribution = {
    source: activity.platform.replace(/_.*$/, ""),
    medium: "community",
    // `ap-<code>` is the shape lib/marketing/events.ts reads back to resolve
    // the activity. Deliberately in `campaign` rather than `content`, which
    // stays reserved for the pre-D-125 share-group slug so both schemes
    // coexist on one teacher's history.
    campaign: `ap-${code}`,
    content: null,
    term: null,
    referrer: null,
  };

  // First-touch wins, exactly as the middleware does: a visitor who arrived
  // from a group two days ago and returns via this link keeps the original
  // credit. The middleware runs on this request too, but only writes when the
  // cookie is absent, so setting it here is the same rule applied earlier.
  const alreadyAttributed = request.headers
    .get("cookie")
    ?.split(";")
    .some((c) => c.trim().startsWith(`${ATTRIBUTION_COOKIE}=`));
  if (!alreadyAttributed) {
    response.cookies.set(ATTRIBUTION_COOKIE, serializeAttribution(attribution), {
      maxAge: ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  }

  // Deliberately NO visit row here. The redirect's own request cannot see the
  // `ap_vid` cookie the middleware is minting on this very response, so
  // recording here and again on the booking page would double-count every
  // first-ever click. The booking page is the single recorder: it resolves this
  // activity back out of the `ap-<code>` campaign tag stamped above, by which
  // point the visitor cookie exists and dedup works.

  return response;
}
