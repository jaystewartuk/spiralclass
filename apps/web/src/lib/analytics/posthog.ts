// PostHog server-side capture (— events captured server-side to dodge
// ad-blockers).
//
// Real `posthog-node` client is initialized lazily on first call when
// POSTHOG_KEY is set. Missing key → console.log fallback (matches the
// stub-first env pattern used by Stripe / Meta / Resend / Inngest).
//
// Distinct ID: teacher_id when the actor is a teacher, student_id when the
// actor is a student. We don't try to merge identities yet.

import { PostHog } from "posthog-node";
import { logger } from "@/lib/logger";
import { posthogRegionHosts } from "@/lib/analytics/posthog-region";
import { sentryEnvironment } from "@/lib/sentry-environment";
import type { AttributionProperties } from "@/lib/analytics/attribution";

const log = logger({ surface: "analytics" });

type CancelTimingProp = "lt24h" | "gte24h" | "teacher";
type OverrideAction =
  | "restore_class"
  | "waive_cancellation"
  | "extend_expiration"
  | "set_custom_price"
  | "mark_complete"
  | "mark_no_show"
  | "archive_student"
  | "reactivate_student"
  | "merge_students"
  | "create_student"
  | "go_live"
  | "create_manual_package"
  | "edit_manual_package"
  | "delete_manual_package"
  | "set_class_language";

// Every variant may carry an optional `sessionId`; when set,
// `trackServerEvent` writes it into the event's `$session_id` property
// so PostHog can stitch the event onto the corresponding session
// recording. Today only the booking funnel forwards a session id (via
// the Payment row at payment_received time); other events will adopt
// it as we wire posthog-js onto more surfaces.
type WithSessionId<T> = T & { sessionId?: string };

export type ServerEvent = WithSessionId<
  | {
      name: "teacher_signup_completed";
      distinctId: string;
      properties: {
        teacherId: string;
      };
    }
  // Returning sign-in (NOT signup — signup fires once, before the teacher row
  // exists). Emitted server-side from the better-auth session.create.after
  // hook, so every session is covered from one place.
  | {
      name: "teacher_signed_in";
      distinctId: string;
      properties: {
        teacherId: string;
      };
    }
  | {
      name: "availability_configured";
      distinctId: string;
      properties: {
        teacherId: string;
        rangesCount: number;
      };
    }
  | {
      name: "package_template_created";
      distinctId: string;
      properties: {
        teacherId: string;
        templateId: string;
        // This event previously fired
        // identically for the auto-seeded starter templates (a system
        // action) and a teacher's own later creates, inflating any
        // "catalog growth" metric. "starter_seed" = the 4 defaults created
        // at lazy Teacher-row creation; "teacher_created" = every other
        // call site (onboarding step 3, Settings → Packages, mobile).
        source: "starter_seed" | "teacher_created";
      };
    }
  // --- Onboarding/activation funnel (docs/architecture/
  // the onboarding activation audit) ---
  | {
      // Fires once, from the first onboarding-wizard step (timezone) — that
      // action has no Settings-reuse path, so every call is genuinely part of
      // the wizard.
      name: "onboarding_started";
      distinctId: string;
      properties: { teacherId: string };
    }
  | {
      // One per wizard step actually submitted (not just viewed). Only fires
      // when the submitting action is genuinely part of onboarding — the
      // availability/templates actions are reused by Settings, so those two
      // steps guard on `redirectTo` not pointing at a Settings page.
      name: "onboarding_step_completed";
      distinctId: string;
      properties: {
        teacherId: string;
        step: "timezone" | "availability" | "templates" | "preview";
      };
    }
  | {
      // "Baseline Configured" in the activation model — finishOnboardingAction
      // stamping onboardingCompleteAt. NOT the same as marketplace_ready below.
      name: "onboarding_finished";
      distinctId: string;
      properties: { teacherId: string };
    }
  | {
      // The headline activation metric: first time isMarketplaceReady()
      // resolves true for this teacher — profile complete, offer + schedule
      // reviewed, and a payout rail connected, on top of Baseline Configured.
      name: "marketplace_ready";
      distinctId: string;
      properties: { teacherId: string };
    }
  | {
      // The isMarketplaceReady() "Profile Complete" sub-signal: first
      // time hasPhoto && hasBio both hold for this teacher. Fires independently
      // of marketplace_ready above — a teacher can complete their profile long
      // before (or after) connecting a payout rail.
      name: "profile_completed";
      distinctId: string;
      properties: { teacherId: string };
    }
  | {
      // First-ever booking/payment for a teacher. Derived with a count check
      // at the same call site as booking_created/payment_received, not a
      // separately-gated write — an analytics-only signal, so the rare
      // double-fire under a concurrent race is an acceptable blemish rather
      // than a correctness bug (contrast payout_rail_connected, which guards
      // a real state transition).
      name: "first_booking_received";
      distinctId: string;
      properties: { teacherId: string; bookingId: string };
    }
  | {
      name: "first_payment_received";
      distinctId: string;
      properties: { teacherId: string; paymentId: string };
    }
  | {
      // Absent before this change, which is what the audit found — the denominator every
      // activation/checklist-engagement funnel needs. Fired once per
      // dashboard/home render from the server component / API route, not
      // from the client, matching this file's ad-blocker-resistant posture.
      name: "dashboard_viewed";
      distinctId: string;
      properties: { teacherId: string; surface: "web" | "mobile" };
    }
  | {
      // Teacher edited their booking slug (the "enlace de reservas"), either
      // during onboarding or later from Settings → Account.
      name: "teacher_booking_slug_changed";
      distinctId: string;
      properties: {
        teacherId: string;
      };
    }
  | {
      // Teacher recorded/uploaded their public-page intro video (D-73). The
      // conversion event of the whole teacher-side funnel — everything before
      // it (recorder opened, recording started/completed, upload started) is a
      // CLIENT event, because the server only ever hears about the attempts
      // that actually reached R2.
      name: "teacher_intro_video_set";
      distinctId: string;
      properties: {
        teacherId: string;
        durationMs: number | null;
        // Which platform's editor produced it.
        surface: "web" | "mobile";
        // How the clip was captured. "record" = in-app camera, "upload" = a
        // file picked from the device. Splits the two funnels, which have very
        // different completion rates and failure modes.
        source: "record" | "upload";
        // Stored object size — the denominator for "did we pick the right cap"
        // and the input to any future transcode-on-ingest decision.
        sizeBytes: number | null;
        // True when this replaces an existing video rather than being the
        // teacher's first. Without it, "how many teachers have a video" and
        // "how many videos were set" silently diverge.
        isReplacement: boolean;
        // Whether AI coach feedback existed for the PREVIOUS video at the
        // moment this one was saved, and how old it was. Together these are
        // the measurement of "do teachers act on the AI suggestions?" — a
        // replacement saved shortly after feedback landed is a teacher acting
        // on it. Null on a first video (nothing to act on).
        afterCoachFeedback: boolean | null;
        coachFeedbackAgeMs: number | null;
      };
    }
  | {
      // Teacher deleted their intro video. The offsetting event to
      // teacher_intro_video_set — without it, a "teachers with a video" count
      // built from set-events only ever goes up.
      name: "teacher_intro_video_removed";
      distinctId: string;
      properties: {
        teacherId: string;
        surface: "web" | "mobile";
        // Whether the video being removed had been analysed. A teacher who
        // deletes right after reading harsh feedback is a signal about the
        // coach's tone, not just about the video.
        hadCoachFeedback: boolean;
      };
    }
  | {
      // The async AI analysis pipeline finished (D-73, Layers 2–3). Fired from
      // the Inngest handler for EVERY terminal outcome, including the skips —
      // "how often is analysis generated" is unanswerable without knowing how
      // often it was skipped and why.
      name: "intro_video_analysis_completed";
      distinctId: string;
      properties: {
        teacherId: string;
        // "transcribed" = ASR succeeded. The skip reasons are the Pro-gate and
        // the staleness/no-video guards.
        outcome: "transcribed" | "no-video" | "stale" | "not-pro" | "no-public-url";
        // Whether Layer 3 produced usable coach feedback on top of the
        // transcript. False on a transcribed video means the Anthropic call
        // failed or was unparseable — the silent-degradation path that would
        // otherwise be invisible.
        coachGenerated: boolean;
        utterances: number | null;
        durationSec: number | null;
        // Wall-clock from the pipeline starting to the row reaching a terminal
        // state — the number that decides whether the editor's 3-minute poll
        // cap is generous or tight.
        latencyMs: number;
        provider: string | null;
      };
    }
  | {
      // The pipeline failed on the vendor call (Inngest will retry). Separate
      // from the completed event so a failure rate is a straight ratio rather
      // than a filter on an outcome property.
      name: "intro_video_analysis_failed";
      distinctId: string;
      properties: {
        teacherId: string;
        reason: string;
        latencyMs: number;
      };
    }
  | {
      name: "booking_created";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        packageId: string;
        // Server-side analytics capture: via_link when the student booked themselves through the
        // public portal flow; direct when a teacher booked on their behalf
        // (item 10, teacher self-serve booking).
        via: "via_link" | "direct";
        // Who initiated the booking. Pairs with `via` so the funnel can split
        // student self-booking from teacher self-serve. Optional for back-compat
        // with the original student-only event shape.
        source?: "student" | "teacher";
        // Present only on teacher-initiated bookings.
        studentId?: string;
        // Denormalized so the funnel doesn't need a person-property join to
        // read a display name. Optional only for back-compat — every call
        // site fills it in.
        teacherName?: string;
        // The package template's own label (e.g. "5 clases de 50 min") and
        // topic (e.g. "Conversación") — null when the package has no
        // template (legacy/manual packages).
        className?: string | null;
        // The platform is 1:1-only today (no group classes — see D-16/D-88),
        // so this reflects the real product distinction instead: a one-off
        // single_class purchase vs a multi-class package.
        classType?: "single_class" | "package";
        // The PackageTemplate id (the "kind" of class), distinct from
        // bookingId (the specific scheduled instance). Null with no template.
        classId?: string | null;
        // ISO timestamp of the booked slot.
        scheduledAt?: string;
      };
    }
  | {
      // Top of the public funnel — a visitor loading /b/[slug].
      //
      // Fired server-side even though posthog-js already autocaptures a
      // $pageview for the same request. They are not redundant: the pageview
      // is client-side (dropped by ad-blockers, and dropped entirely for the
      // FIRST paint if the SDK hasn't booted), carries no teacher identity,
      // and can't be joined to the server-side purchase events by anything
      // other than session id. This one is the funnel denominator, survives
      // ad-blockers, and carries first-touch attribution — so "how many
      // people did that Facebook post send, and how many bought" is one
      // query rather than an unjoinable pair.
      name: "booking_page_viewed";
      distinctId: string;
      properties: {
        teacherId: string;
        slug: string;
        // Cheapest live package, so drop-off can be read against the price
        // actually advertised at the top of the page.
        fromPriceMinorUnits: number | null;
        currency: string | null;
        packageCount: number;
        // Which rails the page could offer. A funnel that dies here on a
        // Wise-only teacher means something different from one that dies
        // with a card option present.
        stripeReady: boolean;
        // Renamed from `wiseReady` by D-113: the signal was always "can a
        // student pay by transfer", and it is now true for SPEI too.
        transferReady: boolean;
        // True when the viewer is the teacher herself — she checks her own
        // page constantly, and counting that as demand would inflate the
        // denominator of every conversion rate on this page.
        isOwner: boolean;
        // Our own user-agent classification (lib/marketing/bots.ts), NOT
        // PostHog's `$virt_is_bot`. That virtual property reads true on 100%
        // of this event, because the event ships from posthog-node with no
        // visitor user agent attached and PostHog is classifying our server
        // rather than the caller — a reading that made this page's traffic
        // look entirely non-human when about a tenth of it is real. Filter on
        // this property instead; the ledger already excludes these.
        isBot: boolean;
      } & AttributionProperties;
    }
  | {
      name: "checkout_started";
      distinctId: string;
      properties: {
        teacherId: string;
        packageId: string;
        paymentId: string;
        // Which rail the student committed to at submit, as the instrument
        // kind (see `payment_received.kind` above — same vocabulary, so the
        // two events compare directly). This is the top of the payment
        // funnel; comparing it to payment_received gives per-instrument
        // completion and, for the Stripe rail, how many card checkouts
        // students start but never finish.
        method: "stripe" | "wise" | "bank_transfer";
        // Which account format a bank transfer used ("mx_clabe", "br_pix",
        // "iban", …). The country-level breakdown lives here rather than in
        // `method`, so `method` stays a three-value rail dimension that every
        // saved funnel can keep grouping by while adoption per country is
        // still measurable.
        scheme?: string;
        priceMinorUnits: number;
        // Which surface initiated the purchase: the anonymous booking-page
        // funnel, or the signed-in repurchase flow in the student portal.
        // Splitting the funnel by source shows whether renewals actually
        // flow through the portal.
        source: "public" | "portal";
        // Carried through from booking_page_viewed so conversion can be
        // broken down by channel without joining across events on session id
        // — which fails precisely when it matters most (a visitor who took
        // two days to decide, or whose session id rotated).
      } & Partial<AttributionProperties>;
    }
  | {
      name: "checkout_failed";
      distinctId: string;
      properties: {
        teacherId: string;
        packageId: string;
        paymentId: string;
        // Only the Stripe rail auto-fails (Wise is teacher-confirmed and
        // never transitions to failed on its own). Abandoned card attempts
        // (student closes the Stripe tab) surface as checkout_started with
        // neither payment_received nor checkout_failed — derivable in the
        // funnel, so we don't emit a separate "abandoned" event.
        rail: string;
      };
    }
  | {
      name: "payment_received";
      distinctId: string;
      properties: {
        teacherId: string;
        packageId: string;
        paymentId: string;
        // Server-side analytics capture prop: every MVP payment is `prepaid` (no booking without
        // payment). The `post` value is reserved for a future flow
        // where teachers settle outside the system and import the receipt.
        // The manual-transfer values are the INSTRUMENT kind, not the
        // provider: `wise` keeps the exact meaning it had before D-113, so
        // every existing PostHog funnel and saved insight survives the
        // generalization, and `bank_transfer` arrives as a new value rather than a
        // re-labelling of an old one. Same model as `prepaid` for funnel
        // analysis, split out so adoption per instrument is measurable.
        kind: "prepaid" | "post" | "wise" | "bank_transfer";
        scheme?: string;
        // The settled amount, so PostHog can sum revenue (not just count
        // payments). Minor units, to match the rest of the money model; build
        // a sum-trend with math `sum` over this property and divide by 100
        // for MXN. Currency is always MXN today (Stripe MX / Wise MXN) but
        // recorded explicitly so a future multi-currency split is a
        // breakdown, not a backfill.
        amountMinorUnits: number;
        currency: string;
      };
    }
  | {
      name: "booking_canceled";
      distinctId: string;
      properties: {
        actor: "student" | "teacher";
        timing: CancelTimingProp;
        bookingId: string;
        teacherId: string;
        // From the pilot teacher's product issues: the teacher-cancel reason (already
        // required + persisted in the Override row) and the student-cancel
        // quick-pick reason, forwarded here so the funnel can break down
        // cancellations by cause. Optional — older/unaffected call sites,
        // and a student who skips the (optional) picker, omit it.
        cancellationReason?: string;
      };
    }
  | {
      name: "reschedule_completed";
      distinctId: string;
      properties: {
        teacherId: string;
        oldBookingId: string;
        newBookingId: string;
      };
    }
  | {
      name: "override_applied";
      distinctId: string;
      properties: {
        teacherId: string;
        action: OverrideAction;
        targetType: "booking" | "package" | "student";
        targetId: string;
        // From the pilot teacher's product issues: only populated for actions with a
        // natural before/after (set_custom_price, set_class_language,
        // extend_expiration) — stringified so the property stays a single
        // scalar shape across actions with different underlying types
        // (minor units, language codes, ISO dates).
        previousValue?: string;
        newValue?: string;
      };
    }
  | {
      name: "materials_attached";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        // "always" = sendTiming null (D-69) — attached with no push schedule,
        // just visible on the class page.
        sendTiming: "confirmation" | "t_5d" | "t_24h" | "t_1h" | "always";
        attachmentKind: "file" | "link";
        surface?: "web" | "mobile";
      };
    }
  | {
      // Teacher created a homework assignment on one of their classes, or the
      // system auto-drafted one from a [!homework]/[!exercise] material
      // callout (docs/features/homework.md, "auto_draft").
      name: "homework_assignment_created";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        assignmentId: string;
        hasDueDate: boolean;
        surface?: "web" | "mobile" | "auto_draft";
      };
    }
  | {
      name: "homework_assignment_deleted";
      distinctId: string;
      properties: {
        teacherId: string;
        assignmentId: string;
        surface?: "web" | "mobile";
      };
    }
  | {
      // Student handed in homework for an assignment (mobile).
      name: "homework_submitted";
      distinctId: string;
      properties: {
        teacherId: string;
        assignmentId: string;
        bookingId: string;
        hasText: boolean;
        fileCount: number;
        late: boolean;
        surface?: "web" | "mobile";
      };
    }
  | {
      // Student attached a file to a homework submission (mobile).
      name: "homework_file_attached";
      distinctId: string;
      properties: {
        teacherId: string;
        assignmentId: string;
        fileType: string;
        sizeBytes: number;
        surface?: "web" | "mobile";
      };
    }
  | {
      // Teacher reviewed a homework attempt and created its HomeworkFeedback
      // (docs/features/homework.md).
      name: "homework_feedback_created";
      distinctId: string;
      properties: {
        teacherId: string;
        assignmentId: string;
        attemptId: string;
        decision: "approved" | "resubmission_requested" | "rejected";
        hasScore: boolean;
        surface?: "web" | "mobile";
      };
    }
  | {
      // Teacher requested (or regenerated) an AI review draft for a homework
      // attempt (docs/features/homework.md). Never fires for a
      // discarded/failed generation — only a successfully persisted draft.
      name: "homework_ai_review_generated";
      distinctId: string;
      properties: {
        teacherId: string;
        assignmentId: string;
        attemptId: string;
        hasMaterialExcerpt: boolean;
        attachmentTextCount: number;
        hasTeacherInstructions: boolean;
      };
    }
  | {
      // Contact-card edit (name / email / phone / timezone) via the
      // student account page or the teacher roster fix. `fields` lists
      // which columns actually changed in this save.
      name: "student_contact_updated";
      distinctId: string;
      properties: {
        studentId: string;
        actorType: "student" | "teacher" | "admin";
        fields: string[];
        teacherId?: string;
      };
    }
  | {
      name: "email_opt_out";
      distinctId: string;
      properties: {
        teacherId: string;
        studentId: string;
        idempotent: boolean;
      };
    }
  | {
      // Teacher-private student notes (add / edit / delete). The note body is
      // deliberately never sent — counts and ids only.
      name: "student_note_added" | "student_note_updated" | "student_note_deleted";
      distinctId: string;
      properties: {
        teacherId: string;
        studentId: string;
      };
    }
  | {
      // Level-gated material library — docs/features/library-materials.md.
      name: "student_level_set";
      distinctId: string;
      properties: {
        teacherId: string;
        studentId: string;
        levelId: string | null;
      };
    }
  | {
      // Durable student profile (interests/goals) — D-20, Layer 1.
      name: "student_profile_set";
      distinctId: string;
      properties: {
        teacherId: string;
        studentId: string;
        hasInterests: boolean;
        hasGoals: boolean;
      };
    }
  | {
      // The language a teacher teaches — the subject, and the focus-tag seed
      // pack selector (D-20 Layer 3, narrowed to language-first by D-72).
      name: "teacher_target_language_set";
      distinctId: string;
      properties: {
        teacherId: string;
        // BCP-47 code from the shared registry; null = cleared.
        targetLanguage: string | null;
      };
    }
  | {
      // Teacher self-service contact edit (name / WhatsApp / time zone) on the
      // teacher account page. `fields` lists which columns actually changed.
      name: "teacher_contact_updated";
      distinctId: string;
      properties: {
        teacherId: string;
        fields: string[];
      };
    }
  | {
      // Teacher opted a public WhatsApp number in/out of the "Chat on
      // WhatsApp" button on /b/<slug>. Separate from teacher_contact_updated
      // above — that one tracks the private account phone, this tracks the
      // public booking-page opt-in.
      name: "teacher_public_whatsapp_updated";
      distinctId: string;
      properties: {
        teacherId: string;
        isSet: boolean;
      };
    }
  | {
      // Teacher verified sign-in-email change landed (auth + row moved).
      name: "teacher_email_updated";
      distinctId: string;
      properties: {
        teacherId: string;
        actorType: "teacher" | "admin";
      };
    }
  | {
      name: "library_item_added";
      distinctId: string;
      properties: {
        teacherId: string;
        levelId: string;
        visibility: "at_or_below" | "exact" | "all";
        attachmentKind: "file" | "link" | "content";
        // Provenance for native-content items (D-20, Layer 4); absent for file/link.
        source?: "manual" | "ai";
        // Gap G1 (docs/features/library-materials.md) — how many focus tags
        // (category/format/theme) this item was tagged with on save.
        tagCount?: number;
      };
    }
  | {
      // Gap G2 — a standalone library material drafted with AI (distinct
      // from class_content_generated, which is per-class).
      name: "library_material_generated";
      distinctId: string;
      properties: {
        teacherId: string;
        hasLevel: boolean;
        hasFormat: boolean;
        focusCount: number;
        hasTopic: boolean;
        // D-69 — whether a saved lesson template's structure drove this
        // generation, mirroring class_content_generated's usedTemplate.
        usedTemplate: boolean;
      };
    }
  | {
      // "Edit with AI" (D-73) — a teacher applied a free-text change to an
      // existing material's body. Burns one shared class_content AI-cap row,
      // same pool as class_content_generated / library_material_generated.
      name: "material_refined";
      distinctId: string;
      properties: {
        teacherId: string;
        instructionChars: number;
        bodyChars: number;
      };
    }
  | {
      // A teacher requested a podcast for one of her materials (enqueued).
      name: "material_podcast_requested";
      distinctId: string;
      properties: {
        teacherId: string;
        materialId: string;
      };
    }
  | {
      // A material's podcast finished generating (audio ready). Burns one shared
      // class_content AI-cap row, same pool as class_content_generated.
      name: "material_podcast_generated";
      distinctId: string;
      properties: {
        teacherId: string;
        materialId: string;
        durationSec: number;
      };
    }
  | {
      // Gap G3 — an existing library item attached onto a reserved class.
      name: "library_item_attached_to_class";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        libraryMaterialId: string;
        sendTiming: "confirmation" | "t_5d" | "t_24h" | "t_1h";
      };
    }
  | {
      // Gap G4 — the auto-surface-by-level class-page setting flipped.
      name: "auto_surface_level_materials_toggled";
      distinctId: string;
      properties: {
        teacherId: string;
        enabled: boolean;
      };
    }
  | {
      // D-132 — the auto-record-classes setting flipped (Settings → Account).
      // Worth a signal of its own: it is the switch that decides whether the
      // insights pipeline runs on a teacher's whole timetable or only on the
      // classes she remembered to record, so adoption of it explains the
      // volume of everything downstream.
      name: "auto_record_classes_toggled";
      distinctId: string;
      properties: {
        teacherId: string;
        enabled: boolean;
      };
    }
  | {
      // Booking-page AI-readability: the intro-video transcript publish
      // opt-in flipped (Settings → Booking page).
      name: "intro_video_transcript_opt_in_toggled";
      distinctId: string;
      properties: {
        teacherId: string;
        optedIn: boolean;
      };
    }
  | {
      // D-78 — teacher saved their AI material style (tone/age/variety/notes),
      // plus D-80's vocabulary dial.
      name: "material_style_saved";
      distinctId: string;
      properties: {
        teacherId: string;
        tone: string | null;
        learnerAge: string | null;
        // Optional; null means "no preference", which resolves to `everyday`
        // during generation.
        vocabulary?: string | null;
        hasVariety: boolean;
        hasCustom: boolean;
        surface?: "mobile";
      };
    }
  | {
      name: "library_item_assigned";
      distinctId: string;
      properties: {
        teacherId: string;
        studentId: string;
        libraryMaterialId: string;
      };
    }
  | {
      name: "library_item_completed";
      distinctId: string;
      properties: {
        teacherId: string;
        studentId: string;
        libraryMaterialId: string;
        completed: boolean;
      };
    }
  | {
      // Student-fired (distinctId = studentId), so no teacherId.
      name: "library_viewed";
      distinctId: string;
      properties: {
        surface: "web" | "mobile";
        itemCount: number;
      };
    }
  // Fires from every chat send route (text/voice/video/image/file, teacher
  // and student, web and mobile) — see lib/chat/analytics.ts's
  // trackMessageSent, the single call site all 20 routes share.
  | {
      name: "message_sent";
      distinctId: string;
      properties: {
        teacherId: string;
        // No Conversation model exists — the (teacher, student) pair IS the
        // thread, so this is a stable synthetic id, not a real row id.
        conversationId: string;
        recipientType: "teacher" | "student";
        hasAttachment: boolean;
      };
    }
  // Discoverability signal for the calendar view (§ PostHog product issue
  // #3) — most students stayed on the flat list without ever finding
  // /my-classes/calendar. entryPoint tracks which affordance got them there
  // (nav bar, the list/calendar toggle) vs a direct/typed/bookmarked visit.
  | {
      name: "calendar_viewed";
      distinctId: string;
      properties: {
        surface: "web" | "mobile";
        // web: nav bar link / the list<->calendar toggle. mobile: the
        // portal's Calendar quick-action button (no nav-bar/toggle
        // equivalent there today).
        entryPoint: "nav" | "list_toggle" | "list_cta" | "direct";
      };
    }
  // Fires when a student opens a material from their organized library
  // (/my-classes/materials web, materials tab mobile) — the downstream
  // engagement signal library_viewed alone couldn't answer (§ PostHog
  // product issue #2). Student-fired; teacherId is present whenever the
  // material resolves to a teacher (always, today — see student-view.ts).
  | {
      name: "material_opened";
      distinctId: string;
      properties: {
        materialId: string;
        materialTitle: string;
        materialType: "content" | "audio" | "file" | "link";
        teacherId?: string;
        surface: "web" | "mobile";
      };
    }
  // Fires when a student finishes consuming a material. Today the only
  // reliable "finished" signal is a generated podcast playing to the end
  // (native content has no other completion event) — see the audio
  // onEnded/didJustFinish handlers on web/mobile.
  | {
      name: "material_completed";
      distinctId: string;
      properties: {
        materialId: string;
        materialTitle: string;
        materialType: "content" | "audio" | "file" | "link";
        teacherId?: string;
        surface: "web" | "mobile";
        durationSeconds?: number;
      };
    }
  // --- Payouts (teacher becomes able to get paid) ---
  // Fires once, on the transition INTO a usable payout rail — the single
  // biggest teacher-activation gate ("can she actually get paid?"). Stripe
  // fires on the atomic charges_enabled false→true transition in the Connect
  // webhook; Wise fires when a teacher first enables their Wise payout details.
  // Both are server-emitted, so they cover web and mobile uniformly.
  | {
      name: "payout_rail_connected";
      distinctId: string;
      properties: {
        teacherId: string;
        // Instrument kind for the manual rail (D-113/D-124) — `wise` keeps the
        // value it emitted before the generalization, so the existing
        // activation funnel is continuous across the cutover.
        rail: "stripe" | "wise" | "bank_transfer";
        scheme?: string;
      };
    }
  // --- Subscription / monetization (docs/features/subscriptions.md) ---
  // All distinctId = teacherId, so the `teacher` group attaches automatically.
  | {
      name: "subscription_checkout_started";
      distinctId: string;
      properties: {
        teacherId: string;
        plan: "monthly" | "annual" | "founding";
      };
    }
  | {
      name: "trial_started";
      distinctId: string;
      properties: { teacherId: string };
    }
  | {
      name: "subscription_activated";
      distinctId: string;
      properties: {
        teacherId: string;
        plan: "monthly" | "annual" | "founding";
        comped: boolean;
      };
    }
  | {
      name: "subscription_payment_failed";
      distinctId: string;
      properties: { teacherId: string };
    }
  | {
      name: "subscription_canceled";
      distinctId: string;
      properties: { teacherId: string };
    }
  | {
      name: "founding_price_locked";
      distinctId: string;
      properties: { teacherId: string; priceMinorUnits: number };
    }
  // Free→paid funnel.
  | {
      name: "plan_limit_hit";
      distinctId: string;
      properties: {
        teacherId: string;
        // Which cap/gate the teacher hit.
        limit:
          | "students"
          | "templates"
          | "materials"
          | "class_content"
          | "custom_price"
          | "lesson_notes"
          | "homework_review";
      };
    }
  | {
      name: "upgrade_viewed";
      distinctId: string;
      // "mobile" was a dead branch —
      // no mobile call site ever existed (there's no in-app upgrade surface
      // on mobile today). Narrowed per the audit's own suggested fix; add
      // "mobile" back if/when a mobile upgrade surface actually ships.
      properties: { teacherId: string; surface: "web" };
    }
  | {
      name: "upgraded";
      distinctId: string;
      properties: {
        teacherId: string;
        plan: "monthly" | "annual" | "founding";
      };
    }
  | {
      name: "downgraded_to_free";
      distinctId: string;
      properties: {
        teacherId: string;
        // Why they dropped: trial lapsed, grace elapsed, or explicit cancel.
        reason: "trial_expired" | "past_due_grace_elapsed" | "canceled";
      };
    }
  | {
      name: "library_item_opened";
      distinctId: string;
      properties: {
        libraryMaterialId: string;
        surface: "web" | "mobile";
      };
    }
  // In-class live notes (docs/features/classes-lesson-content.md).
  | {
      name: "lesson_note_created";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        audience: "teacher" | "student";
      };
    }
  // AI post-class summary (live-notes-panel.md "step 2").
  | {
      name: "lesson_summary_generated";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
      };
    }
  // Native class content (docs/features/classes-lesson-content.md, D-17).
  | {
      name: "class_content_saved";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        source: "manual" | "ai";
        chars: number;
      };
    }
  | {
      name: "class_content_generated";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        hasLevel: boolean;
        coveredCount: number;
        // Lesson continuity: how many previous-class materials were picked as
        // "continue from" context (0 = the generic continuity nudge only).
        continuationCount: number;
        // D-20 structured inputs: how many focus tags, and whether the durable
        // profile / a free-text topic contributed.
        focusCount?: number;
        hasInterests?: boolean;
        hasGoals?: boolean;
        hasTopic?: boolean;
        // Whether the teacher's lesson template shaped the structure (D-46).
        usedTemplate?: boolean;
      };
    }
  // --- Student acquisition (docs/features/student-acquisition.md, D-24) ---
  // Booking-page conversion funnel. `lead_captured` fires on the public route, so
  // its distinctId is the visitor's PostHog session id (anonymous) rather than a
  // teacher/student id; teacherId in properties still attaches the `teacher`
  // group so the funnel aggregates per teacher. The status-change events fire
  // from the teacher dashboard (distinctId = teacherId).
  | {
      name: "lead_captured";
      distinctId: string;
      properties: {
        teacherId: string;
        leadId: string;
        hasPhone: boolean;
        hasMessage: boolean;
        // A lead is the OTHER conversion this page produces — the visitor who
        // wasn't ready to buy. Attributing it matters as much as attributing a
        // purchase: a channel that sends browsers rather than buyers looks
        // dead on revenue alone.
      } & Partial<AttributionProperties>;
    }
  | {
      name: "lead_contacted" | "lead_converted" | "lead_archived";
      distinctId: string;
      properties: {
        teacherId: string;
        leadId: string;
      };
    }
  // Social previews (D-123). Two events, and deliberately only two.
  //
  // The acquisition loop these feed is ALREADY closed by the attribution
  // pipeline: shareTaggedUrl() stamps utm_content with the group's slug, the
  // ap_src cookie carries it, and attributionProperties() puts it on
  // booking_page_viewed / checkout_started / payment_received. So "funny meme
  // -> N landings -> M purchases" is a breakdown by utm_content joined to the
  // preview configured for that group — no new click tracking, no redirect
  // service, no per-impression event.
  //
  // What was genuinely missing is feature health and the angle dimension, which
  // is all these two carry. Note the honest limit: we count LANDINGS, not clicks
  // on a Facebook post — nobody can count the latter without owning the redirect.
  | {
      name: "social_preview_generated";
      distinctId: string;
      properties: {
        teacherId: string;
        angle: string;
        hasTopic: boolean;
        // Whether the brief carried a community's own instructions, which is
        // the dimension that tells us whether the per-community brief is
        // actually being used or is dead configuration.
        forCommunity?: boolean;
        ok: boolean;
        // The failure vocabulary from generateSocialPreviewImage — "cap" and
        // "blocked" are product signals, not incidents.
        reason?: string;
      };
    }
  | {
      name: "social_preview_selected";
      distinctId: string;
      properties: {
        teacherId: string;
        source: string;
        angle: string | null;
        // null = the teacher's default preview rather than a per-group one.
        shareGroupId: string | null;
      };
    }
  // Deletion of a stored image. Counted because an image the teacher throws
  // away is the clearest signal a generation missed — and the volume of it is
  // what says whether the brief pipeline is working.
  | {
      name: "social_preview_image_deleted";
      distinctId: string;
      properties: { teacherId: string };
    }
  // Discount-code primitive (Phase 2 slice 2a, docs/features/referrals-discounts.md).
  // Fired (distinctId = student.id) when a valid code reduces a checkout charge.
  | {
      name: "discount_applied";
      distinctId: string;
      properties: {
        teacherId: string;
        packageId: string;
        paymentId: string;
        discountMinorUnits: number;
        chargedMinorUnits: number;
      };
    }
  // Student→student referrals (slice 2b). `attributed` fires at checkout
  // (distinctId = referred student); `qualified`/`rewarded` fire from the
  // grant-referral-reward worker once the friend's payment settles.
  | {
      name: "referral_attributed";
      distinctId: string;
      properties: {
        teacherId: string;
        packageId: string;
        paymentId: string;
        discountMinorUnits: number;
      };
    }
  | {
      name: "referral_qualified" | "referral_rewarded";
      distinctId: string;
      properties: {
        teacherId: string;
        referralId: string;
        rewardMinorUnits?: number;
      };
    }
  // Teacher → Student invitation funnel (D-83). Teacher-side events use
  // distinctId = teacher.id; student-side acceptance/onboarding events use
  // distinctId = student.id so time-to-acceptance stitches across the same
  // Person. `channel` distinguishes web from the mobile deep-link accept.
  | {
      // `created` fires per invitation minted; `sent` per successful email
      // delivery; `resent`/`cancelled` on those actions. `bulk_completed` fires
      // once per bulk operation with the batch counts.
      name: "invitation_created" | "invitation_sent" | "invitation_resent" | "invitation_cancelled";
      distinctId: string;
      properties: {
        teacherId: string;
        invitationId: string;
        // "single" | "bulk" — how the invitation was initiated.
        source?: "single" | "bulk";
      };
    }
  | {
      name: "invitation_bulk_completed";
      distinctId: string;
      properties: {
        teacherId: string;
        requested: number;
        sent: number;
        skippedDuplicate: number;
        skippedConnected: number;
        skippedInvalid: number;
      };
    }
  | {
      // Student-side funnel. `opened` fires when the accept landing is viewed;
      // `accepted` when the account is linked; `existing_account_linked` when
      // acceptance attached an inbox that already had a login (vs a fresh
      // signup). distinctId is the student.id once known, else the teacherId
      // fallback for the anonymous `opened` view.
      name: "invitation_opened";
      distinctId: string;
      properties: {
        teacherId: string;
        channel: "web" | "mobile";
      };
    }
  | {
      name: "invitation_accepted" | "invitation_existing_account_linked";
      distinctId: string;
      properties: {
        teacherId: string;
        invitationId: string;
        studentId: string;
        channel: "web" | "mobile";
        // Minutes from invitation send to acceptance — time-to-acceptance.
        minutesToAccept?: number;
      };
    }
  | {
      // A class-call room became active (LiveKit `room_started`). First real
      // call-lifecycle signal in PostHog — previously the whole in-class call
      // (join, leave, recording) was invisible to product analytics.
      name: "call_started";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
      };
    }
  | {
      name: "call_participant_left";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        role: "teacher" | "student" | "unknown";
      };
    }
  | {
      // Egress accepted the room-composite recording start (egress_started),
      // distinct from the recording finishing (call_recording_finalized) or
      // being toggled from the UI — this is the provider-confirmed signal.
      name: "call_recording_started";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
      };
    }
  // --- Video call analytics audit follow-up (docs/architecture/
  // VIDEO_CALL_POSTHOG_AUDIT.md) — everything below closes a gap that report
  // found. `call_started`/`call_participant_left`/`call_recording_started`
  // above predate the audit and are unchanged. ---
  | {
      // The webhook counterpart `call_started`/`call_participant_left` were
      // missing this half of the presence pair — `participant_joined` was
      // already parsed and already used to trigger lesson-audio capture, so
      // this is the cheapest fix the call-analytics review found.
      name: "call_participant_joined";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        role: "teacher" | "student" | "unknown";
      };
    }
  | {
      // Top of the reminder→joined funnel — the reminder
      // ladder (lib/notifications/dispatcher.ts) had zero analytics before
      // this. `recipientType` distinguishes the teacher-facing reminder
      // variants from the student-facing ones.
      name: "call_reminder_sent";
      distinctId: string;
      properties: {
        teacherId: string;
        studentId?: string;
        bookingId: string;
        channel: "push" | "email";
        leadTimeMinutes: number;
        recipientType: "teacher" | "student";
      };
    }
  | {
      // Low-priority forward of the two webhook kinds that were already
      // parsed and already did DB work in webhook-events.ts but never
      // reached PostHog — recording_ended (this room's A/V
      // egress finished, successfully or not) and room_finished (the call
      // actually ended, from the server's point of view).
      name: "call_recording_finished";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
        failed: boolean;
      };
    }
  | {
      name: "call_room_finished";
      distinctId: string;
      properties: {
        teacherId: string;
        bookingId: string;
      };
    }
>;

let cached: PostHog | null = null;
let initFailed = false;

// Per-process dedup so we don't ship a fresh `$identify` event on every
// authenticated page load. PostHog's pipeline would dedupe anyway, but
// we'd still be charged for the events. Reset on process restart — on the
// Fly.io persistent container (D-70/D-89) that's a deploy/restart, not a
// per-request boundary, so the dedup applies across many requests, not just
// within one.
const identifiedThisProcess = new Set<string>();

function getClient(): PostHog | null {
  if (cached) return cached;
  if (initFailed) return null;
  const key = process.env.POSTHOG_KEY;
  if (!key) return null;
  try {
    cached = new PostHog(key, {
      // POSTHOG_HOST is an explicit override; unset falls back to the
      // region-derived ingest host (NEXT_PUBLIC_POSTHOG_REGION, default US)
      // so a single region knob flips server + browser together — see D-48.
      host: process.env.POSTHOG_HOST ?? posthogRegionHosts().ingest,
      flushAt: 1,
      flushInterval: 0,
      // When set, posthog-node evaluates feature flags LOCALLY (from a
      // cached definition it polls) instead of calling /flags per check.
      // Optional — without it, flags evaluate remotely. See env.ts.
      ...(process.env.POSTHOG_PERSONAL_API_KEY
        ? { personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY }
        : {}),
    });
    return cached;
  } catch {
    initFailed = true;
    return null;
  }
}

// Fire-and-forget: we never block a server action on analytics. With
// POSTHOG_KEY missing or in tests, log to stderr and return; with a real
// client, capture and let posthog-node flush in the background.
export function trackServerEvent(event: ServerEvent): void {
  if (process.env.NODE_ENV === "test") return;
  // Stamp the deployment environment on every server event so preview traffic
  // (the APK + preview.spiralclass.com both point at the preview backend, whose
  // posthog-node fires these) is separable from production in insights. These
  // events are the ones the launch dashboard is built on, and posthog-node has
  // no super-property mechanism, so it's added per event. Hostname/Vercel-based
  // via sentryEnvironment — NOT NODE_ENV (a preview build is NODE_ENV=production).
  //
  // Also stamps `platform: "web"` — every ServerEvent here is emitted by this
  // process (the apps/web backend), so it's a fixed value, not derived
  // per-request. It was fixed even when a native client existed, which is why
  // the field survived that client. Some ServerEvent variants additionally
  // carry their own `surface`/`channel` property distinguishing which client
  // UI triggered the event — that's a separate, existing signal; `platform`
  // only answers "which app emitted this event".
  const properties: Record<string, unknown> = {
    ...event.properties,
    environment: sentryEnvironment(),
    platform: "web",
  };
  if (event.sessionId) properties.$session_id = event.sessionId;
  // Attach the teacher as a PostHog group on every event carrying a
  // teacherId. Booking/payment events are keyed by student.id while teacher
  // lifecycle events are keyed by teacher.id; the `teacher` group bridges
  // the two so funnels and breakdowns can aggregate per teacher across both
  // identity domains. Mirrors the client-side posthog.group("teacher", …)
  // call in posthog-identify.tsx. Every current ServerEvent variant has a
  // teacherId, so this applies to all of them.
  const teacherId = (event.properties as { teacherId?: string }).teacherId;
  const groups = teacherId ? { teacher: teacherId } : undefined;
  const client = getClient();
  if (!client) {
    log.info(event.name, {
      distinctId: event.distinctId,
      ...(groups ? { groups } : {}),
      ...properties,
    });
    return;
  }
  client.capture({
    distinctId: event.distinctId,
    event: event.name,
    properties,
    ...(groups ? { groups } : {}),
  });
}

// Identify the authenticated actor to PostHog so session replays, event
// funnels, and the Persons view associate with a real user record rather
// than a distinctId-only ghost. Called from the auth boundary helpers
// (requireTeacher / requireStudent / requireAdmin); fire-and-forget like
// trackServerEvent. Idempotent within a process via identifiedThisProcess.
// Alias pairs already emitted this process — the merge is idempotent in
// PostHog, but re-sending it on every checkout is pure noise.
const aliasedThisProcess = new Set<string>();

/**
 * Merge an anonymous browser identity into the real one.
 *
 * The public funnel is measured across two different distinct ids: the browser
 * events (`$pageview`, `booking_page_viewed`, `checkout_submitted`) key on
 * posthog-js's anonymous id, while the purchase events (`checkout_started`,
 * `payment_received`) key on `student.id`, because the server has no other
 * stable handle on the buyer. PostHog funnels group by PERSON, so without a
 * merge the funnel reads as 100% drop-off after the page view — every visitor
 * appears to abandon, and every conversion appears to come from nowhere.
 *
 * It self-heals only if the buyer later signs into the portal, where
 * posthog-js's `identify()` performs this same merge. Purchase is the moment we
 * first know both ids, and a buyer who never signs in would otherwise never be
 * counted as converting — so do it here rather than hoping.
 *
 * Verified against the 2026-07-29 production test purchase, whose funnel spanned
 * `019fafae…` (browser) and `e0fda820…` (student) with no link between them.
 */
export function aliasServerUser(distinctId: string, anonymousId: string): void {
  if (process.env.NODE_ENV === "test") return;
  // Nothing to merge, and PostHog rejects a self-alias.
  if (!anonymousId || anonymousId === distinctId) return;

  const pair = `${anonymousId}->${distinctId}`;
  if (aliasedThisProcess.has(pair)) return;
  aliasedThisProcess.add(pair);

  const client = getClient();
  if (!client) {
    log.info("alias", { distinctId, anonymousId });
    return;
  }
  try {
    client.alias({ distinctId, alias: anonymousId });
  } catch {
    // Analytics never blocks a purchase.
  }
}

export function identifyServerUser(
  distinctId: string,
  properties: { email?: string | null; role: "teacher" | "student" | "admin" },
): void {
  if (process.env.NODE_ENV === "test") return;
  if (identifiedThisProcess.has(distinctId)) return;
  identifiedThisProcess.add(distinctId);

  const personProps: Record<string, string> = { role: properties.role };
  if (properties.email) personProps.email = properties.email;

  const client = getClient();
  if (!client) {
    log.info("identify", { distinctId, ...personProps });
    return;
  }
  client.identify({ distinctId, properties: personProps });
}

// Server-side feature flag evaluation. Use in Server Components / actions
// / route handlers to gate behavior. ALWAYS returns the `fallback` when
// PostHog is unavailable (no key, init failed, test env) or the call
// throws — flags must never break the request path. Pass the same
// distinctId you identify with (teacher.id / student.id) so server and
// client see the same variant.
export async function isServerFeatureEnabled(
  key: string,
  distinctId: string,
  fallback = false,
): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return fallback;
  const client = getClient();
  if (!client) return fallback;
  try {
    const enabled = await client.isFeatureEnabled(key, distinctId);
    return enabled ?? fallback;
  } catch {
    return fallback;
  }
}

// Multivariate variant of the above — returns the variant key (string) or
// the boolean for a simple flag. Used for experiments evaluated
// server-side. Returns `fallback` (default the string "control") on any
// failure so experiment branches default safely.
export async function getServerFeatureFlag(
  key: string,
  distinctId: string,
  fallback: string | boolean = "control",
): Promise<string | boolean> {
  if (process.env.NODE_ENV === "test") return fallback;
  const client = getClient();
  if (!client) return fallback;
  try {
    const value = await client.getFeatureFlag(key, distinctId);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

// posthog-node's flushAt/flushInterval settings still batch+background the
// actual HTTP POST — a request/Inngest step/cron run can finish (and, on a
// more aggressively recycled runtime than today's Fly.io container, get torn
// down) before that POST completes. Call this at the end of every handler
// that fires a server event (server action, webhook, Inngest function) to
// drain it deterministically instead of relying on incidental process
// longevity. Safe to call when no client.
export async function flushAnalytics(): Promise<void> {
  if (!cached) return;
  try {
    await cached.shutdown();
  } catch {
    // Drop — analytics never blocks the request path.
  }
  cached = null;
}
