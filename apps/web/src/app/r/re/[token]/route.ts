import { notificationLinkRoute } from "@/lib/auth/notification-link-route";

// Rebook link (D-40). When a teacher cancels a class, the dispatcher sends the
// student a `teacher_cancel` (or `cancel_gte24h_with_reschedule` /
// `cancel_lt24h`) notification whose button points here with a single-use
// token (lib/auth/notification-link.ts). GET shows a button; POST redeems the
// token, signs the student in, and lands her on /my-classes/book with the
// credit pool of the canceled class pre-selected.
const route = notificationLinkRoute("rebook");

export const GET = route.GET;
export const POST = route.POST;
