/**
 * The route manifest for the visual baseline.
 *
 * Every page route in the app, with the session it needs and — where the path
 * carries parameters — how to fill them. The capture spec
 * (tests/visual/capture.spec.ts) walks this list at each viewport and theme.
 *
 * Why a hand-maintained manifest rather than a filesystem crawl: a crawl
 * cannot know that `/dashboard/classes/[bookingId]/call` needs a LiveKit room
 * that does not exist outside a real class, that `/i/[token]` consumes its
 * token on first view, or that `/maintenance` is only reachable when the app
 * is broken. Those distinctions are the whole difficulty, and a list that
 * states them is honest where a crawl would silently capture 40 error pages
 * and call it a baseline.
 *
 * Keeping it in sync is cheap and self-enforcing: tests/visual/manifest.test.ts
 * compares this list against the filesystem and fails when a route is added
 * without a decision about how it gets captured.
 */

/** Which session a route renders under. */
export type Tier = "public" | "teacher" | "student" | "admin";

/** Why a route is not captured, when it is not. */
export type Excluded =
  /** Needs live infrastructure that cannot be posed (a LiveKit room, an active call). */
  | "live"
  /** A one-shot token that is consumed or invalidated by viewing it. */
  | "single-use"
  /** Only reachable in a failure state the harness must not induce. */
  | "failure-state"
  /** Renders no UI — a redirect or a file response. */
  | "no-ui";

export type Route = {
  /** URL path, with any parameters already substituted or named for resolution. */
  path: string;
  /** Short label used in the screenshot filename and the gallery. */
  name: string;
  tier: Tier;
  /**
   * The parameters this route needs resolved from seed data before capture.
   * The spec looks each up once and substitutes it into `path` by name, so a
   * route with two parameters lists both.
   */
  resolve?: ResolveKey | ResolveKey[];
  /** Set when the route is deliberately not captured. */
  excluded?: Excluded;
  /**
   * Marks the surfaces a stranger evaluating the product actually reaches.
   * These get the tightest review and are the ones adopted as
   * visual-regression baselines first.
   */
  portfolio?: true;
};

/**
 * A value the capture spec resolves once from the seeded database and
 * substitutes for the `:id` placeholder in a path.
 */
export type ResolveKey =
  | "bookingId"
  | "studentId"
  | "teacherId"
  | "paymentId"
  | "packageId"
  | "adminTeacherId"
  | "adminStudentId"
  | "adminPackageId"
  | "activityId"
  // Resolving this also pins `bookingId` to the SAME assignment's class: the
  // student homework page 404s when the two disagree, so two independently
  // picked seed rows would photograph a not-found page.
  | "assignmentId"
  | "helpAudience"
  | "helpSlug";

/** The seeded teacher whose public funnel is the capture fixture. Matches the
 * slug the a11y sweep and the production synthetic probe already use. */
export const TEACHER_SLUG = process.env.VISUAL_TEACHER_SLUG ?? "alicia-moreno";

// ---------------------------------------------------------------------------
// Public — no session. Capturable against any deployed URL.
// ---------------------------------------------------------------------------

export const PUBLIC_ROUTES: Route[] = [
  { path: "/", name: "landing", tier: "public", portfolio: true },
  { path: "/features", name: "features", tier: "public", portfolio: true },
  { path: "/pricing", name: "pricing", tier: "public", portfolio: true },
  { path: "/about", name: "about", tier: "public", portfolio: true },
  { path: "/help", name: "help-index", tier: "public", portfolio: true },
  { path: "/terms", name: "terms", tier: "public" },
  { path: "/privacy-notice", name: "privacy", tier: "public" },
  // The design system, rendered from the tokens. Noindex — it is for whoever
  // is building or evaluating the product, not for search — but public, so a
  // reviewer can reach it without an account.
  { path: "/design", name: "design-system", tier: "public", portfolio: true },
  // The public demo (D-142). Portfolio-tier because it is one of the two URLs
  // a reviewer is sent to, and it renders the real dashboard component — so a
  // regression here is a regression on the signed-in screen as well.
  { path: "/demo", name: "demo-dashboard", tier: "public", portfolio: true },
  { path: "/sign-in", name: "sign-in", tier: "public", portfolio: true },
  { path: "/sign-up", name: "sign-up", tier: "public", portfolio: true },

  // The booking funnel — the acquisition surface, and the second thing a
  // stranger reaches after the landing page.
  { path: `/b/${TEACHER_SLUG}`, name: "booking", tier: "public", portfolio: true },
  // NOT `portfolio`, so it is captured but never pixel-asserted — and this is
  // the same rule the regression spec already states for authenticated screens,
  // applied to the one public page that breaks it.
  //
  // /buy renders the slot picker, whose chips are live availability. The
  // regression spec pins the BROWSER clock (page.clock), which fixes the date
  // it shows; it cannot pin the SERVER, which loads seeded bookings and
  // blocked dates across a real `now → now + maxAdvanceDays` window. So as real
  // days pass, seeded bookings drift against the pinned date, a different
  // number of chips survives, and the page's HEIGHT changes — 1436px to 1387px
  // between 2026-08-30 and 2026-08-31, one row of chips, on a branch that
  // touched nothing on this page.
  //
  // That is not drift a baseline should catch; it is the baseline expiring on a
  // timer. Left in, it goes red on main every few days for everyone, which is
  // precisely how the three earlier baseline failures trained people to ignore
  // this suite. Cover for this page is the unit tests over PurchaseFlow's
  // ordering rules (tests/checkout/purchase-flow-order.test.tsx), which assert
  // structure rather than pixels and do not care what day it is.
  { path: `/b/${TEACHER_SLUG}/buy`, name: "booking-buy", tier: "public" },

  // The mobile magic-link fallback. A real page with its own (entirely inline)
  // styling, which is exactly why it belongs in the baseline.
  { path: "/m/login", name: "mobile-login", tier: "public" },

  // Renders only when the app is deliberately taken down; capturing it would
  // mean inducing that state.
  { path: "/maintenance", name: "maintenance", tier: "public", excluded: "failure-state" },

  // Reached with a live checkout reference. The result and rail screens are
  // captured through the authenticated purchase flow instead.
  {
    path: `/b/${TEACHER_SLUG}/buy/result`,
    name: "booking-result",
    tier: "public",
    excluded: "single-use",
  },
  {
    path: `/b/${TEACHER_SLUG}/buy/transfer/:ref`,
    name: "booking-transfer",
    tier: "public",
    excluded: "single-use",
  },
  {
    path: `/b/${TEACHER_SLUG}/buy/wise/:ref`,
    name: "booking-wise",
    tier: "public",
    excluded: "single-use",
  },

  // Invitation and notification-preference links are consumed on first view.
  { path: "/i/:token", name: "invitation", tier: "public", excluded: "single-use" },
  {
    path: "/r/notif-settings/:token",
    name: "notif-settings",
    tier: "public",
    excluded: "single-use",
  },

  // Help articles gate on a session, so an anonymous capture would photograph
  // the sign-in redirect. Captured under the teacher tier instead.
  { path: "/help/:audience", name: "help-audience", tier: "teacher", resolve: "helpAudience" },
  { path: "/help/:audience/:slug", name: "help-article", tier: "teacher", resolve: "helpSlug" },
];

// ---------------------------------------------------------------------------
// Teacher — the core product.
// ---------------------------------------------------------------------------

export const TEACHER_ROUTES: Route[] = [
  { path: "/dashboard", name: "dashboard", tier: "teacher", portfolio: true },
  { path: "/dashboard/customize", name: "dashboard-customize", tier: "teacher" },
  { path: "/dashboard/calendar", name: "calendar", tier: "teacher", portfolio: true },
  { path: "/dashboard/classes", name: "classes", tier: "teacher", portfolio: true },
  { path: "/dashboard/classes/book", name: "classes-book", tier: "teacher" },
  {
    path: "/dashboard/classes/:bookingId",
    name: "class-detail",
    tier: "teacher",
    resolve: "bookingId",
    portfolio: true,
  },
  {
    path: "/dashboard/classes/:bookingId/content",
    name: "class-content",
    tier: "teacher",
    resolve: "bookingId",
  },
  {
    path: "/dashboard/classes/:bookingId/content/edit",
    name: "class-content-edit",
    tier: "teacher",
    resolve: "bookingId",
  },

  { path: "/dashboard/students", name: "students", tier: "teacher", portfolio: true },
  { path: "/dashboard/students/nuevo", name: "student-new", tier: "teacher" },
  {
    path: "/dashboard/students/:studentId",
    name: "student-detail",
    tier: "teacher",
    resolve: "studentId",
    portfolio: true,
  },
  { path: "/dashboard/students/invitations", name: "invitations", tier: "teacher" },
  { path: "/dashboard/students/invitations/nuevo", name: "invitation-new", tier: "teacher" },

  { path: "/dashboard/messages", name: "messages", tier: "teacher" },
  { path: "/dashboard/messages/new", name: "message-new", tier: "teacher" },
  {
    path: "/dashboard/messages/:studentId",
    name: "message-thread",
    tier: "teacher",
    resolve: "studentId",
  },

  { path: "/dashboard/materials", name: "materials", tier: "teacher", portfolio: true },
  { path: "/dashboard/leads", name: "leads", tier: "teacher" },
  { path: "/dashboard/testimonials", name: "testimonials", tier: "teacher" },
  { path: "/dashboard/discounts", name: "discounts", tier: "teacher" },
  { path: "/dashboard/referrals", name: "referrals", tier: "teacher" },
  { path: "/dashboard/share-groups", name: "share-groups", tier: "teacher" },

  { path: "/dashboard/get-students", name: "get-students", tier: "teacher" },
  { path: "/dashboard/get-students/profile", name: "get-students-profile", tier: "teacher" },
  {
    path: "/dashboard/get-students/communities",
    name: "get-students-communities",
    tier: "teacher",
  },
  { path: "/dashboard/get-students/results", name: "get-students-results", tier: "teacher" },
  {
    path: "/dashboard/get-students/:activityId",
    name: "get-students-activity",
    tier: "teacher",
    resolve: "activityId",
  },

  { path: "/payments", name: "payments", tier: "teacher", portfolio: true },
  {
    path: "/payments/:paymentId",
    name: "payment-detail",
    tier: "teacher",
    resolve: "paymentId",
  },
  // `portfolio`, so the authenticated axe sweep covers it: it is one of the
  // few teacher screens reached from the app bar on every visit, and its
  // rows carry the icon/colour marks a contrast check has to see. Teacher
  // -tier portfolio routes are NOT pixel-asserted — regression.spec.ts is
  // scoped to the public tier — so this adds accessibility coverage only.
  { path: "/notifications", name: "notifications", tier: "teacher", portfolio: true },

  { path: "/settings/account", name: "settings-account", tier: "teacher" },
  {
    path: "/settings/booking-page",
    name: "settings-booking-page",
    tier: "teacher",
    portfolio: true,
  },
  {
    path: "/settings/availability",
    name: "settings-availability",
    tier: "teacher",
    portfolio: true,
  },
  { path: "/settings/blocked-dates", name: "settings-blocked-dates", tier: "teacher" },
  { path: "/settings/calendar", name: "settings-calendar", tier: "teacher" },
  { path: "/settings/templates", name: "settings-templates", tier: "teacher" },
  {
    path: "/settings/class-content-templates",
    name: "settings-content-templates",
    tier: "teacher",
  },
  { path: "/settings/focus-tags", name: "settings-focus-tags", tier: "teacher" },
  { path: "/settings/materials", name: "settings-materials", tier: "teacher" },
  { path: "/settings/payments", name: "settings-payments", tier: "teacher" },
  { path: "/settings/billing", name: "settings-billing", tier: "teacher" },
  { path: "/settings/notifications", name: "settings-notifications", tier: "teacher" },

  { path: "/onboarding/reading", name: "onboarding-reading", tier: "teacher", portfolio: true },
  { path: "/onboarding/timezone", name: "onboarding-timezone", tier: "teacher", portfolio: true },
  { path: "/onboarding/templates", name: "onboarding-templates", tier: "teacher" },
  { path: "/onboarding/availability", name: "onboarding-availability", tier: "teacher" },
  { path: "/onboarding/preview", name: "onboarding-preview", tier: "teacher" },

  // Both need a live LiveKit room and an egress recording respectively.
  {
    path: "/dashboard/classes/:bookingId/call",
    name: "class-call",
    tier: "teacher",
    excluded: "live",
  },
  {
    path: "/dashboard/classes/:bookingId/replay",
    name: "class-replay",
    tier: "teacher",
    excluded: "live",
  },
  {
    path: "/dashboard/classes/:bookingId/homework/:assignmentId",
    name: "homework-review",
    tier: "teacher",
    excluded: "live",
  },
];

// ---------------------------------------------------------------------------
// Student — the portal.
// ---------------------------------------------------------------------------

export const STUDENT_ROUTES: Route[] = [
  { path: "/my-classes", name: "student-home", tier: "student", portfolio: true },
  { path: "/my-classes/calendar", name: "student-calendar", tier: "student" },
  {
    path: "/my-classes/:bookingId",
    name: "student-class",
    tier: "student",
    resolve: "bookingId",
  },
  {
    path: "/my-classes/:bookingId/content",
    name: "student-class-content",
    tier: "student",
    resolve: "bookingId",
  },
  {
    path: "/my-classes/:bookingId/reschedule",
    name: "student-reschedule",
    tier: "student",
    resolve: "bookingId",
  },
  {
    // Order matters: assignmentId resolves first and pins bookingId to the
    // same class, because the page 404s when the URL's class and the
    // assignment's own disagree.
    path: "/my-classes/:bookingId/homework/:assignmentId",
    name: "student-homework",
    tier: "student",
    resolve: ["assignmentId", "bookingId"],
  },
  { path: "/my-classes/book", name: "student-book", tier: "student", portfolio: true },
  { path: "/my-classes/book/confirmation", name: "student-book-confirm", tier: "student" },
  { path: "/my-classes/buy", name: "student-buy", tier: "student" },
  { path: "/my-classes/materials", name: "student-materials", tier: "student" },
  { path: "/my-classes/progress", name: "student-progress", tier: "student", portfolio: true },
  { path: "/my-classes/messages", name: "student-messages", tier: "student" },
  { path: "/my-classes/messages/new", name: "student-message-new", tier: "student" },
  {
    path: "/my-classes/messages/:teacherId",
    name: "student-message-thread",
    tier: "student",
    resolve: "teacherId",
  },
  { path: "/my-classes/teachers", name: "student-teachers", tier: "student" },
  {
    path: "/my-classes/teachers/:teacherId",
    name: "student-teacher-detail",
    tier: "student",
    resolve: "teacherId",
  },
  { path: "/my-classes/account", name: "student-account", tier: "student" },

  {
    path: "/my-classes/:bookingId/call",
    name: "student-call",
    tier: "student",
    excluded: "live",
  },
];

// ---------------------------------------------------------------------------
// Admin — internal ops. Captured for completeness and because the tables and
// charts here are the densest responsive surfaces in the product.
// ---------------------------------------------------------------------------

export const ADMIN_ROUTES: Route[] = [
  { path: "/admin", name: "admin-overview", tier: "admin" },
  { path: "/admin/teachers", name: "admin-teachers", tier: "admin" },
  {
    path: "/admin/teachers/:adminTeacherId",
    name: "admin-teacher-detail",
    tier: "admin",
    resolve: "adminTeacherId",
  },
  { path: "/admin/students", name: "admin-students", tier: "admin" },
  {
    path: "/admin/students/:adminStudentId",
    name: "admin-student-detail",
    tier: "admin",
    resolve: "adminStudentId",
  },
  { path: "/admin/payments", name: "admin-payments", tier: "admin" },
  { path: "/admin/money", name: "admin-money", tier: "admin" },
  { path: "/admin/costs", name: "admin-costs", tier: "admin" },
  { path: "/admin/economics", name: "admin-economics", tier: "admin" },
  { path: "/admin/packages", name: "admin-packages", tier: "admin" },
  {
    path: "/admin/packages/:adminPackageId",
    name: "admin-package-detail",
    tier: "admin",
    resolve: "adminPackageId",
  },
  { path: "/admin/subscriptions", name: "admin-subscriptions", tier: "admin" },
  { path: "/admin/disputes", name: "admin-disputes", tier: "admin" },
  { path: "/admin/notifications", name: "admin-notifications", tier: "admin" },
  { path: "/admin/lesson-insights", name: "admin-lesson-insights", tier: "admin" },
  { path: "/admin/audit", name: "admin-audit", tier: "admin" },
  { path: "/admin/integrations", name: "admin-integrations", tier: "admin" },
  { path: "/admin/storage", name: "admin-storage", tier: "admin" },
  { path: "/admin/database", name: "admin-database", tier: "admin" },
  { path: "/admin/security", name: "admin-security", tier: "admin" },
  { path: "/admin/staff", name: "admin-staff", tier: "admin" },
  { path: "/admin/uat", name: "admin-uat", tier: "admin" },
  { path: "/admin/live-calls", name: "admin-live-calls", tier: "admin", excluded: "live" },
];

export const ALL_ROUTES: Route[] = [
  ...PUBLIC_ROUTES,
  ...TEACHER_ROUTES,
  ...STUDENT_ROUTES,
  ...ADMIN_ROUTES,
];

/** Routes actually captured — everything without an exclusion reason. */
export const capturable = (tier?: Tier): Route[] =>
  ALL_ROUTES.filter((r) => !r.excluded && (tier ? r.tier === tier : true));
