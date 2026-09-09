// Structured UAT runbook content — the canonical source for /admin/uat
// (D-55). Edit this file directly;
// there is no markdown doc and no build step. Each item has a stable `id` so
// checklist state and the automated action bindings are explicit data, not
// text-matching against rendered markdown.
//
// Sections are grouped into categories so a tester can run just one slice
// (e.g. "Booking & notifications") instead of the whole thing end to end.
// The "Booking & notifications" category deliberately does NOT depend on a
// fresh purchase (§B) — it signs in as an already-seeded student with an
// active package (Lucía Fuentes / alumno.beatriz.1@spiralclass.com) so it
// can be run completely on its own after any reseed.
export type UatCategory =
  | "setup"
  | "purchase"
  | "booking-notifications"
  | "messaging"
  | "video"
  | "subscription"
  | "observability";

export const CATEGORY_LABELS: Record<UatCategory, string> = {
  setup: "Setup",
  purchase: "Purchase & refund",
  "booking-notifications": "Booking & notifications",
  messaging: "Messaging",
  video: "Video call",
  subscription: "Subscription",
  observability: "Observability",
};

// Which screen a step runs on. `teacher-web`/`student-web` are the signed-in
// web dashboard (`/dashboard/...`) and student web portal (`/my-classes/...`)
// respectively; `web` is the browser hand-off (Stripe Checkout/Billing).
export type UatSurface = "teacher-web" | "student-web" | "web" | "repo";

export const SURFACE_LABEL: Record<UatSurface, string> = {
  "teacher-web": "Teacher — web dashboard",
  "student-web": "Student — web portal",
  web: "Browser (checkout/billing)",
  repo: "Repo / dashboard",
};

export type UatLoginAs = { email: string; name: string };

export type UatAutomatedAction = "probe" | "posthog" | "stripe";

export type UatCopyValue = { label: string; value: string };

export type UatItem = {
  id: string;
  surface?: UatSurface;
  loginAs?: UatLoginAs;
  // Plain text. `**bold**` and `` `code` `` are lightly parsed for emphasis —
  // see formatInline() in uat-runbook.tsx. Keep sentences short.
  text: string;
  copyValues?: UatCopyValue[];
  expect?: string;
};

export type UatSection = {
  id: string;
  title: string;
  category: UatCategory;
  note?: string;
  items: UatItem[];
  action?: UatAutomatedAction;
};

const BEATRIZ: UatLoginAs = {
  email: "profe.pro.monthly@spiralclass.com",
  name: "Beatriz Soto (teacher)",
};
const TRIAL_TEACHER: UatLoginAs = {
  email: "profe.trial@spiralclass.com",
  name: "Fernando (trial teacher)",
};
const FREE_TEACHER: UatLoginAs = {
  email: "profe.free@spiralclass.com",
  name: "Gabriela (Free-tier teacher)",
};
const LUCIA: UatLoginAs = {
  email: "alumno.beatriz.1@spiralclass.com",
  name: "Lucía Fuentes (student, active package)",
};

export const UAT_SECTIONS: UatSection[] = [
  {
    id: "0",
    title: "Pre-flight",
    category: "setup",
    items: [],
    action: "probe",
  },
  {
    id: "A",
    title: "Teacher sign-in",
    category: "setup",
    items: [
      {
        id: "A.signin-web",
        surface: "teacher-web",
        loginAs: BEATRIZ,
        text: "Open **`/sign-in`** in the browser → enter the email above → **Send code** → enter the code from the `@spiralclass.com` inbox (or **Continue with Google**, if configured).",
        expect: "Signs in, lands on `/dashboard`.",
      },
      {
        id: "A.analytics",
        text: "Analytics (confirmed later in Observability): this returning sign-in produces one `teacher_signed_in` on the teacher's Person.",
      },
    ],
  },
  {
    id: "A+",
    title: "Connect a payout rail",
    category: "setup",
    note: "`payout_rail_connected` fires only on the **off→on transition** — re-saving an already-enabled rail is silent by design. This account is seeded with **neither rail**, so both steps below are genuine off→on flows. Sign back into Beatriz afterward.",
    items: [
      {
        id: "A+.wise-web",
        surface: "teacher-web",
        loginAs: TRIAL_TEACHER,
        text: "**`/settings/payments` → Enable Wise** → fill **Wisetag** and **Account holder** → **Save**.",
        copyValues: [
          { label: "Wisetag", value: "uat-teacher" },
          { label: "Account holder", value: "UAT Teacher" },
        ],
        expect: "Wise shows enabled.",
      },
      {
        id: "A+.wise-analytics",
        text: "Analytics: one `payout_rail_connected` (`rail=wise`) fires. Saving again on the already-enabled card must NOT fire a second one.",
      },
      {
        id: "A+.stripe-web",
        surface: "teacher-web",
        loginAs: TRIAL_TEACHER,
        text: "Still not Stripe-connected: **`/settings/payments` → Connect Stripe** → complete Stripe's test-mode onboarding → return to the dashboard.",
        expect: "Payments shows charges enabled.",
      },
      {
        id: "A+.stripe-analytics",
        text: "Analytics: the `charges_enabled` false→true fires one `payout_rail_connected` (`rail=stripe`). Optional — skip if short on time; the Wise leg above already proves the event pipeline.",
      },
    ],
  },
  {
    id: "B",
    title: "Student — first-time purchase (Stripe)",
    category: "purchase",
    note: "Guest checkout — no sign-in to buy. Opens in the **browser** (Stripe Checkout is a browser tab).",
    items: [
      {
        id: "B.open",
        surface: "web",
        text: "Open the teacher's public page → tap **Pick a package**.",
        copyValues: [
          { label: "Teacher page", value: "https://preview.spiralclass.com/b/beatriz-soto" },
        ],
        expect: "The buy screen lists the packages.",
      },
      {
        id: "B.checkout",
        surface: "web",
        text: "Pick a package → method **Pay by card** → enter **name** and **email** fresh (the public buy page never pre-fills) → **Continue to payment**.",
        copyValues: [
          { label: "Name", value: "UAT Alumno" },
          { label: "Email", value: "alumno.uat@spiralclass.com" },
        ],
      },
      {
        id: "B.pay",
        surface: "web",
        text: "Stripe Checkout opens → pay with the test card (any future expiry, any CVV).",
        copyValues: [{ label: "Test card", value: "4242 4242 4242 4242" }],
        expect: "Returns to the app success/result screen.",
      },
      {
        id: "B.notify-web",
        surface: "student-web",
        text: "Email arrives (payment receipt + a separate first-payment magic-link email). Click the magic-link email to land on **My Classes**.",
        expect: "Lands on `/my-classes` signed in, package shows as active.",
      },
    ],
    action: "stripe",
  },
  {
    id: "G",
    title: "Refund the purchase above (real reversal)",
    category: "purchase",
    items: [
      {
        id: "G.refund-web",
        surface: "teacher-web",
        loginAs: BEATRIZ,
        text: "**`/payments`** → the test payment from §B → open it → **Refund** → reason (3+ chars) → confirm.",
        expect: "Payment → refunded.",
      },
    ],
    action: "stripe",
  },
  {
    id: "BW",
    title: "Book, cancel, reschedule + notifications (web)",
    category: "booking-notifications",
    note: "Booking, cancel and reschedule end to end, run independently. Checks email delivery and that the dashboard and portal reflect each change. Same seeded student (5 classes left, 2 upcoming bookings) so it can run right after a reseed.",
    items: [
      {
        id: "BW.signin-student",
        surface: "student-web",
        loginAs: LUCIA,
        text: "In one browser tab/profile, open **`/sign-in`** and sign in as the student (she's already a buyer, so this is the returning sign-in, not guest checkout).",
        expect: "`/my-classes` shows an active package (5 classes left) with 2 upcoming bookings.",
      },
      {
        id: "BW.signin-teacher",
        surface: "teacher-web",
        loginAs: BEATRIZ,
        text: "In a second browser tab/profile, sign in as the teacher too — she should get her own confirmation/cancel/reschedule emails at the same time as the student's.",
        expect: "Signed in, `/dashboard` visible.",
      },
      {
        id: "BW.book",
        surface: "student-web",
        loginAs: LUCIA,
        text: "**Student tab**: `/my-classes/book` → pick a slot **≥26h out** → confirm.",
        expect:
          "Confirmation screen; the new booking shows on `/my-classes`. Confirmation and new-class-booked emails arrive for student and teacher respectively.",
      },
      {
        id: "BW.cancel",
        surface: "student-web",
        loginAs: LUCIA,
        text: "**Student tab**: `/my-classes` → the booking **~10 days out** → **Cancel** → confirm.",
        expect:
          "Cancelled, disappears from Upcoming. Cancellation emails arrive for student and teacher.",
      },
      {
        id: "BW.reschedule",
        surface: "student-web",
        loginAs: LUCIA,
        text: "**Student tab**: `/my-classes` → the booking **~3 days out** → **Reschedule** (`/my-classes/<id>/reschedule`) → pick a different slot ≥26h out → confirm.",
        expect:
          "Booking updates to the new time. Reschedule emails arrive for student and teacher.",
      },
      {
        id: "BW.compare",
        surface: "teacher-web",
        text: "**Teacher tab**: refresh `/dashboard/classes` and confirm the booking/cancel/reschedule above all show with the right date/time and student name. Confirm every email above actually arrived (subject + body match the notification's intent, not just that something landed).",
      },
    ],
  },
  {
    id: "D",
    title: "Messaging — text + voice",
    category: "messaging",
    items: [
      {
        id: "D.text-web",
        surface: "teacher-web",
        loginAs: BEATRIZ,
        text: "**`/dashboard/messages`** → the student's thread → send a text.",
        expect: "Appears.",
      },
      {
        id: "D.reply-web",
        surface: "student-web",
        loginAs: LUCIA,
        text: "**`/my-classes/messages`** → see it → send a reply.",
        expect: "Appears on the teacher's `/dashboard/messages` thread.",
      },
      {
        id: "D.voice-web",
        surface: "teacher-web",
        loginAs: BEATRIZ,
        text: "Record a voice note (mic button — the browser will ask for microphone permission) → **Send voice**.",
        expect: "Voice bubble plays.",
      },
      {
        id: "D.voice-play-web",
        surface: "student-web",
        loginAs: LUCIA,
        text: "Play the voice note.",
        expect: "Plays back.",
      },
    ],
  },
  {
    id: "I",
    title: "Video call",
    category: "video",
    note: "**Priority for Monday's launch**: the first real paying student joins her class via the browser (`/my-classes/<id>/call`) — run these items at least once before Monday. Requires the teacher to be on a **Pro** plan with LiveKit env vars configured (`getVideoProvider()` returns null and the join button doesn't render otherwise) — confirm §J or that the teacher is already Pro first.",
    items: [
      {
        id: "I.teacher-join-web",
        surface: "teacher-web",
        loginAs: BEATRIZ,
        text: "Open a scheduled class (`/dashboard/classes/<bookingId>`) → in the **Live notes** card, click **Join call**.",
        expect: "Opens `/dashboard/classes/<id>/call` — video room with camera preview.",
      },
      {
        id: "I.student-join-web",
        surface: "student-web",
        loginAs: LUCIA,
        text: "Open the same class (`/my-classes/<bookingId>`) → click **Join video call**.",
        expect: "Opens `/my-classes/<id>/call` — both see and hear each other.",
      },
      {
        id: "I.controls",
        text: "Toggle mic (mute/unmute) and camera (off/on) on either side.",
        expect: "Both work, other side notices.",
      },
      {
        id: "I.leave",
        text: "Both tap **Leave**.",
        expect: "Back to the booking detail, no crash.",
      },
    ],
  },
  {
    id: "J",
    title: "Subscription upgrade — Free → Pro",
    category: "subscription",
    items: [
      {
        id: "J.signin-web",
        surface: "teacher-web",
        loginAs: FREE_TEACHER,
        text: "**`/settings/billing`**.",
        expect: "Free-tier state (Pro upsell shown, caps enforced).",
      },
      {
        id: "J.upgrade",
        surface: "web",
        text: "**Upgrade to Pro** → **Monthly** (or Annual) → pay with the test card. Stripe Billing checkout opens in the browser.",
        copyValues: [{ label: "Test card", value: "4242 4242 4242 4242" }],
        expect: "Returns to the app.",
      },
      {
        id: "J.unlocked-web",
        surface: "teacher-web",
        text: "Pro features unlock on the web dashboard (video-call entry, live-notes, caps lifted).",
      },
      {
        id: "J.cancel",
        surface: "web",
        text: "Optional: cancel the sub in the Stripe Customer Portal.",
        expect: "App re-locks Pro.",
      },
    ],
  },
  {
    id: "K1",
    title: "Jobs & webhooks",
    category: "observability",
    items: [
      {
        id: "K1.inngest",
        surface: "repo",
        text: "Inngest: `transfer-on-paid`, `auto-complete-sweep-cron`, `reminder-scan-cron`, `magic-link-on-first-payment` all green.",
      },
      {
        id: "K1.webhooks",
        surface: "repo",
        text: "Stripe Dashboard → Webhooks: `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded` all 2xx.",
      },
    ],
  },
  {
    id: "K2",
    title: "Analytics pipeline (PostHog)",
    category: "observability",
    note: "The silent-failure guard. Earlier sections already generated these events — this confirms they actually **landed**, on the right Persons.",
    items: [
      {
        id: "K2.tiles",
        surface: "repo",
        text: "The **Bookings per day** and **Paid lessons per day** tiles on the PostHog dashboard moved.",
        copyValues: [
          // D-158: no project id. PostHog's own navigation is one click and
          // does not need this repository to carry an account identifier.
          { label: "Dashboard", value: "PostHog → Dashboards → the K2 tiles dashboard" },
        ],
      },
    ],
    action: "posthog",
  },
];

export const GO_NO_GO = {
  block: [
    "Any purchase, refund, or subscription upgrade step fails.",
    "A teacher cannot connect a payout rail — she can't get paid.",
    "The probe fails.",
    "A notification is missing from both channels, or the notifications are indistinguishable from each other.",
    "Video call fails with a config error. The web join path is what the first real student uses.",
    "Any new unresolved Sentry error in a payment, auth, video, or billing path.",
  ],
  notBlocking: [
    "Cosmetic/copy/layout issues (triage as P1).",
    "Analytics events not landing — a P1 observability gap, not a product blocker.",
  ],
};
