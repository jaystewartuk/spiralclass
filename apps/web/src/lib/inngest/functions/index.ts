import { dispatchNotificationFn } from "./dispatch-notification";
import { reminderScanCronFn } from "./reminder-scan";
import { magicLinkOnFirstPaymentFn } from "./magic-link-on-first-payment";
import { grantReferralRewardFn } from "./grant-referral-reward";
import { autoBookOnPaidFn } from "./auto-book-on-paid";
import { autoCompleteSweepCronFn } from "./auto-complete-sweep";
import { materialsPurgeCronFn } from "./materials-purge";
import { cleanupPendingPackagesCronFn } from "./cleanup-pending-packages";
import { reconcilePaidPaymentsCronFn } from "./reconcile-paid-payments";
import { pollWiseStatementsCronFn } from "./poll-wise-statements";
import { anomalyAlertsCronFn } from "./anomaly-alerts";
import { accountDeletionCronFn } from "./account-deletion";
import { packageExpiryNudgeCronFn } from "./package-expiry-nudge";
import { packageConsumedNudgeCronFn } from "./package-consumed-nudge";
import { weeklyPlanNudgeCronFn } from "./weekly-plan-nudge";
import { wiseConfirmReminderCronFn } from "./wise-confirm-reminder";
import { subscriptionSweepCronFn } from "./subscription-sweep";
import { syncGoogleCalendarsCronFn } from "./sync-google-calendars";
import { onLessonAudioReadyFn } from "./on-lesson-audio-ready";
import { onLessonTranscriptReadyFn } from "./on-lesson-transcript-ready";
import { onLessonInsightsReadyFn } from "./on-lesson-insights-ready";
import { onMaterialPodcastRequestedFn } from "./on-material-podcast-requested";
import { onIntroVideoReadyFn } from "./on-intro-video-ready";
import { adminReseedPreviewFn } from "./admin-reseed-preview";
import { onReminderDueFn } from "./on-reminder-due";
import { onBookingCreatedFn } from "./on-booking-created";
import { invitationsPendingNudgeCronFn } from "./invitations-pending-nudge";
import { redispatchQueuedCronFn } from "./redispatch-queued";
import { homeworkDueSoonNudgeCronFn, homeworkOverdueNudgeCronFn } from "./homework-reminder-nudge";
import { isPreviewDeployment } from "@/lib/env";

// Event-driven functions — registered in EVERY environment. Each one only runs
// when something actually sends its event, so an idle deploy costs nothing, and
// preview needs them for the Maestro flows to behave like the real app.
//
// onReminderDueFn is the reminder wake chain's delivery end (D-115). It's event-
// driven, so it exists on preview too, but only the prod-only producers
// (`reminder-scan-cron` and `on-booking-created`, both kept off preview below)
// ever arm a `reminder.due` — preview stays idle.
export const eventFunctions = [
  dispatchNotificationFn,
  magicLinkOnFirstPaymentFn,
  grantReferralRewardFn,
  autoBookOnPaidFn,
  onLessonAudioReadyFn,
  onLessonTranscriptReadyFn,
  onLessonInsightsReadyFn,
  onMaterialPodcastRequestedFn,
  onIntroVideoReadyFn,
  adminReseedPreviewFn,
  onReminderDueFn,
];

// Cron functions — registered everywhere EXCEPT the preview deploy.
//
// Every tick is a DB touch, and Neon's scale-to-zero timer is fixed at 5 min on
// the Free plan, so one touch buys 5 minutes of billed compute. Left on, this
// fleet pinned BOTH Neon projects awake ~24/7 (≈182 CU-hours/month against a
// 100 CU-hour/project/month free allowance, which suspends the compute for the
// rest of the billing period once spent — see isPreviewDeployment in lib/env).
//
// Preview is the half that bought nothing: no real users to remind, no real
// payments to reconcile, no real pushes to chase receipts for. No Maestro flow
// waits on a cron either — completed/no-show bookings are minted directly by
// the deleted Maestro fixture script — so nothing downstream regresses.
//
// Cadence rule for anything added here: fire on minute :00 and nothing else.
// Because a wake lasts a fixed 5 min, ticks that share a minute share one wake
// window, so the total spend is set by how many DISTINCT minutes the fleet uses
// — an off-grid schedule like `5 * * * *` or `30 16 * * *` opens a whole extra
// window for one job. tests/jobs/crons.test.ts enforces this.
//
// The grid was :00/:15/:30/:45 until D-115, when it collapsed to :00 alone:
// 96 ticks/day measured ~11 active h/day on production (~89 of the 100 free
// CU-hours a month), against ~0.7 min of actual work per tick — the other 8
// h/day was pure scale-to-zero idle timer. Nothing in this fleet needed a
// sub-hourly poll except reminder-scan's 15m leg, and that now rides a wake
// chain instead of the grid (lib/notifications/reminder-scan.ts). If a job ever
// genuinely needs sub-hourly precision, arm a delayed event the same way rather
// than tightening the grid for everyone.
export const cronFunctions = [
  reminderScanCronFn,
  autoCompleteSweepCronFn,
  materialsPurgeCronFn,
  cleanupPendingPackagesCronFn,
  reconcilePaidPaymentsCronFn,
  pollWiseStatementsCronFn,
  anomalyAlertsCronFn,
  accountDeletionCronFn,
  packageExpiryNudgeCronFn,
  packageConsumedNudgeCronFn,
  weeklyPlanNudgeCronFn,
  wiseConfirmReminderCronFn,
  subscriptionSweepCronFn,
  syncGoogleCalendarsCronFn,
  invitationsPendingNudgeCronFn,
  redispatchQueuedCronFn,
  homeworkDueSoonNudgeCronFn,
  homeworkOverdueNudgeCronFn,
];

// Event-driven functions that must nevertheless stay OFF the preview deploy.
//
// These are triggered by events, not by a clock, so they don't pin Neon awake
// the way a cron does — but they DRIVE the reminder wake chain, and preview
// registers no crons precisely so that no reminder ever fires there (Maestro
// fixtures must not receive reminder emails/pushes). onReminderDueFn above is
// safe on preview only because nothing there ever produces `reminder.due`;
// `booking.created`, by contrast, is emitted by every booking path the flows
// exercise, so onBookingCreatedFn on preview would start the chain from each
// Maestro booking. It goes in this list, not eventFunctions, for that reason.
// A function belongs here iff it is event-driven AND (re)starts a chain that
// preview deliberately leaves dormant.
export const productionOnlyEventFunctions = [onBookingCreatedFn];

// Exported (rather than inlined below) so a test can assert both branches
// without stubbing the env — the preview branch is the one that must never
// silently regain a cron, or a chain-starter from productionOnlyEventFunctions.
export function registeredFunctions(isPreview: boolean) {
  return isPreview
    ? eventFunctions
    : [...eventFunctions, ...productionOnlyEventFunctions, ...cronFunctions];
}

export const functions = registeredFunctions(isPreviewDeployment());
