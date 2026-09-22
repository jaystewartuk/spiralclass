import { notificationLinkRoute } from "@/lib/auth/notification-link-route";

// Portal sign-in link (D-40). After a student's first paid checkout, the
// dispatcher's `magic_link` template points its button here with a single-use
// token (lib/auth/notification-link.ts) — as a path suffix, because Meta's
// URL-button variables cannot carry a whole URL. GET shows a button; POST
// redeems the token, signs the student in, links her login to her roster row,
// and lands her on /my-classes.
const route = notificationLinkRoute("magic-link");

export const GET = route.GET;
export const POST = route.POST;
