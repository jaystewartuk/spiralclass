import type { MaterialFileKind } from "./material-file-kind";
import type { PayoutInstrumentKind } from "./payout-instruments";
// Serialisable shapes that cross a boundary — a route handler's JSON body, a
// Server Component's props into a Client Component, a data-channel payload.
//
// ⚠️ THIS FILE WAS THE MOBILE-WEB WIRE CONTRACT, and most of it was. It defined
// the JSON for the 220 routes under `/api/mobile/*` that
// a workspace deletion orphaned and a later one removed; that change left the
// types in
// place deliberately, inert and typed, to be swept in their own change rather
// than hidden inside a 33,000-line deletion. This is that change: 75 types with
// no reachable reference are gone, 1,898 lines down to 1,098.
//
// What is left is what something still reads. A type here has to earn its place
// by being referenced from outside this file (directly, or through another type
// that is) — the same test that produced the deletion. If you add one for a
// consumer you have not written yet, it is dead code with a plan attached.
//
// Conventions, unchanged and still load-bearing wherever a shape is serialised:
//   * Dates are ISO 8601 strings (UTC unless noted) — never Date objects.
//   * Money is in integer minor units of the amount's own currency — never floats.
//   * Status enums are wire-stable strings; mappers translate any DB-side
//     variants (e.g. `canceled_by_student` → `canceled`).
//   * `null` for "absent"; never `undefined` over the wire.

// ---------------------------------------------------------------------------
// Session / auth
// ---------------------------------------------------------------------------

import type { MaterialLearnerAge, MaterialTone, MaterialVocabulary } from "./validators";

export type UserRole = "teacher" | "student" | "admin" | "superuser" | "guest";

// The wire-level locale identifier. Aliased to the shared locale registry's
// AppLocale so there is ONE source of truth for the supported set — adding a
// language to ./i18n/locales.ts widens this automatically, rather than needing
// a parallel edit here and at every serialised type.
import type { AppLocale } from "./i18n/locales";
import type { MaterialTag } from "./materials-grouping";
export type LocaleCode = AppLocale;

export type SessionUser = {
  id: string;
  // Canonical id for analytics (PostHog distinct_id): Teacher.id for teachers,
  // Student.id for students, else the auth user id. Matches the key the web app
  // and the server-event pipeline use, so a person resolves to ONE PostHog
  // Person across the client and the server. Optional for forward-compat with
  // older backends that predate it (clients fall back to `id`).
  analyticsId?: string;
  email: string;
  name: string | null;
  role: UserRole;
  locale: LocaleCode;
  timezone: string | null;
  onboardingComplete: boolean;
  bookingSlug: string | null;
  // True when this identity is on the SUPERUSER_EMAILS env allowlist
  // specifically (lib/env.ts isSuperuser()) — kept distinct from `isAdmin`
  // below because it's also the env-bootstrap path admin.ts's loadAdminActor
  // falls back to on a fresh DB with no admin_users rows yet.
  isSuperuser: boolean;
  // True when this identity has ANY admin_users row (any AdminRole, not
  // disabled) — mirrors web's loadAdminActor()/resolveAdminActor() DB-backed
  // gate, so a support/finance admin (not necessarily env-allowlisted) also
  // reaches the admin surface. This — not `isSuperuser` — is the field
  // clients should branch on for "does this identity belong in the admin
  // interface." True whenever `isSuperuser` is true too (the env allowlist is
  // one path into admin, not a separate privilege tier).
  isAdmin: boolean;
  // Public profile photo URL (version-stamped for cache-busting), or null when
  // the person hasn't uploaded one — the client renders an initials monogram
  // instead. Populated for teachers by buildMobileSessionUser. Optional for
  // forward-compat with older backends that predate it (clients fall back to
  // the monogram).
  photoUrl?: string | null;
  // Whether a Google account is currently linked for sign-in (better-auth
  // Account row, providerId "google"). Drives the connect/reconnect Google
  // affordance on the account settings screens — see
  // lib/auth/identity-change.ts on the server for why this can flip to false
  // right after an email change. Optional for forward-compat with older
  // backends that predate it.
  googleLinked?: boolean;
};

// ---------------------------------------------------------------------------
// Teacher
// ---------------------------------------------------------------------------

export type StripeConnectStatus = "connected" | "pending" | "disconnected";

export type Teacher = {
  id: string;
  name: string;
  email: string;
  bookingSlug: string;
  timezone: string;
  // ISO-3166-1 alpha-2. Used client-side as a same-market default for a
  // student's phone-country picker on this teacher's public booking page.
  country: string;
  stripeStatus: StripeConnectStatus;
  wiseEnabled: boolean;
  onboardingComplete: boolean;
  // Public profile photo URL (version-stamped for cache-busting), or null when
  // the teacher hasn't uploaded one — the client renders an initials monogram
  // instead. Populated server-side by toWireTeacher.
  photoUrl: string | null;
  // Public intro-video URL (version-stamped), or null when there's no video or
  // the storage bucket isn't configured. Rendered under the hero on the public
  // booking page via <video>. Populated by toWireTeacher (D-73).
  introVideoUrl: string | null;
  // Duration of the intro video in ms (capture-time), or null when unknown.
  introVideoDurationMs: number | null;
};

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

export type PackageTemplate = {
  id: string;
  name: string;
  // Optional topic label (e.g. "Conversation") — distinct from `name`, which
  // is the size/duration label. Null when unset.
  subject: string | null;
  classCount: number;
  // Individual class sold one at a time — the student pays when reserving a
  // slot, instead of buying a multi-class package up front. classCount is
  // always 1 for these.
  singleClass: boolean;
  durationMinutes: number;
  priceStripeCents: number;
  priceWiseCents: number | null;
  currency: string;
  expirationMonths: number;
  active: boolean;
};

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export type BookingStatus = "scheduled" | "completed" | "canceled" | "no_show" | "rescheduled";

export type Booking = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  studentName: string;
  studentId: string;
  // Null when the student hasn't set one yet — clients fall back to the
  // teacher's zone (same fallback the notification dispatcher uses).
  studentTimezone: string | null;
  teacherName: string;
  teacherId: string;
  teacherTimezone: string;
  packageId: string;
  packageName: string;
  durationMinutes: number;
  rescheduledFromId: string | null;
  expiresAt: string | null;
  // Whether at least one ClassMaterial is attached. Omitted (not false) on
  // endpoints that don't fetch the count — only the teacher booking list
  // populates it today, to drive the "needs materials" indicator.
  hasMaterials?: boolean;
};

// ---------------------------------------------------------------------------
// Class materials
// ---------------------------------------------------------------------------

export type MaterialSendTiming = "confirmation" | "t_5d" | "t_24h" | "t_1h";

// "content" is reusable native Markdown content authored in-app (D-20, Layer 4):
// the item has a `body` instead of a file/link, rendered natively like
// ClassContent. "file"/"link" items have a viewUrl; "content" items have a body.
export type MaterialAttachmentKind = "file" | "link" | "content";

export type Material = {
  id: string;
  label: string | null;
  // The material's "primary" piece — kept for category grouping and back-compat
  // clients. Post-unification a single material may carry a body AND a file AND
  // a link at once; `attachmentKind`/`viewUrl` reflect whichever piece is
  // primary (content > file > link), while the granular fields below expose
  // every piece so a renderer can surface all of them on one material.
  attachmentKind: MaterialAttachmentKind;
  // Signed URL (storage-backed) or raw URL (link). Null only on bad data
  // rows that have no storage path AND no link URL.
  viewUrl: string | null;
  // Individual content pieces — any combination may be present. Absent/null =
  // that piece isn't on this material. `body` is native Markdown; `fileUrl` is
  // the signed URL for an attached file; `linkUrl` is an external link.
  body?: string | null;
  fileUrl?: string | null;
  linkUrl?: string | null;
  // True when the file piece is a raster image (derived from the stored
  // filename — no MIME type is persisted; see material-file-kind.ts). Lets a
  // client show the picture inline instead of a bare "open this" link, which
  // is the whole point for a visual learner. Absent/false = render the link.
  isImage?: boolean;
  // Null = "always visible, no notification" (D-69's exposed always-visible
  // state) — the attachment isn't on a push schedule at all.
  sendTiming: MaterialSendTiming | null;
  createdAt: string;
  // The material's tags (across its categories) and level label, for chips +
  // category grouping on the class pages. Optional: only populated by callers
  // that select the tag join / level (the student & teacher class endpoints);
  // absent (treated as none) elsewhere.
  tags?: MaterialTag[];
  levelLabel?: string | null;
  // Teacher class view only: true when this row is a library item attached to
  // the class (BookingLibraryMaterial) rather than a fresh booking-scoped
  // upload — the client detaches it (by this `id` = libraryMaterialId) instead
  // of deleting it. Absent/false = a fresh upload.
  attachedFromLibrary?: boolean;
};

// A material as shown inside the in-call material viewer — the panel a teacher
// or student opens DURING the video call to look at a class material without
// leaving the call. Unlike `Material`, a `content` item carries its Markdown
// `body` inline so the call can render it natively with no second fetch; `file`
// and `link` items carry a signed `viewUrl`. Both the web
// call pages and the call-token response are populated from the single
// server helper `getCallMaterials` (apps/web/src/lib/materials/call-materials.ts),
// so the two platforms can't drift.
export type CallMaterial = {
  id: string;
  label: string | null;
  kind: MaterialAttachmentKind;
  // Set only when kind === "content"; null otherwise.
  body: string | null;
  // Set for "file" (signed URL) and "link" (raw URL); null for "content".
  viewUrl: string | null;
  // Set only when kind === "file": whether that file has an in-page renderer
  // ("pdf"/"image") or still has to open outside the call ("other"). Resolved
  // server-side from the stored filename (materialFileKind) rather than in the
  // viewer, so the picker can say which items leave the call BEFORE one is
  // picked, and so a signed URL's query string is never the thing a renderer
  // is chosen by. Null for "content" and "link" — neither has a stored file.
  fileKind: MaterialFileKind | null;
};

// Native class content (D-17). One Markdown body per booking authored by the
// teacher (optionally AI-drafted, then reviewed). `source` records whether the
// saved body originated from a manual write or an AI generation. Viewing is
// free; authoring (PUT/generate) is Pro-gated server-side.
export type ClassContentSource = "manual" | "ai";

// The teacher's focus-tag picker, grouped by category (D-20, Layer 2) — the
// mirror of the `focusGroups` the web teacher page builds for ClassContentPanel.
// `categoryLabel` comes pre-resolved from the server (the category row's own
// `label`) — the client never re-derives it from a key.
export type ClassContentFocusGroup = {
  categoryId: string;
  categoryLabel: string;
  tags: { id: string; label: string }[];
};

// A teacher's editable focus-tag category (it went from a
// free-text/fixed-enum field on each tag to its own manageable taxonomy) — the
// CRUD counterpart to the grouping above, used by the focus-tag settings
// surface. A save is a replace-set,
// same convention as FocusTagRow below; archiving (deleting) a category the
// teacher still has active tags filed under is rejected (409) rather than
// silently orphaning them — she has to move or delete those tags first.
export type FocusTagCategoryRow = {
  id: string;
  label: string;
  position: number;
};

// A teacher's editable focus tag (D-20's deferred follow-up: "rename / add /
// reorder / archive") — the CRUD counterpart to the read-only picker above,
// used by the focus-tag settings surface. `categoryId` must reference one of
// the teacher's own active FocusTagCategoryRow ids. A save is a
// replace-set: any existing tag whose id
// is missing from the submitted array gets archived, mirroring how
// PackageTemplate saves; a `tmp-`-prefixed id is created.
export type FocusTagRow = {
  id: string;
  label: string;
  categoryId: string;
  position: number;
};

// A previous class's material a teacher can pick as "continue from" context
// when generating a new class's content (lesson continuity). `preview` is a
// short plain-text snippet, not the full body — the full body is resolved
// server-side again at generation time from the id, never trusted from the
// client.
export type ContinuationCandidate = {
  materialId: string;
  bookingId: string;
  label: string | null;
  scheduledStart: string;
  preview: string;
};

// In-class live notes (live-notes-panel.md, D-15). A per-booking cue list with
// two audiences from one author. The teacher endpoint returns both; the student
// endpoint returns only `audience: "student"` rows, gated server-side to the
// class window. `done` is meaningful only for teacher-audience cues.
export type LessonNoteAudience = "teacher" | "student";

export type LessonNote = {
  id: string;
  audience: LessonNoteAudience;
  body: string;
  position: number;
  done: boolean;
};

// The lifecycle of a student's submission, from the student's point of view.
// Mirrors the DB HomeworkSubmissionStatus plus two derived, display-only states
// the server computes and never stores:
//   * "not_submitted" — no submission row yet (the student hasn't started).
//   * "late"          — submitted after the assignment's dueAt.
// `returned` and `graded` are future teacher-review states — modelled here so
// the client can render them without a later wire change.
export type HomeworkSubmissionStatus =
  "not_submitted" | "draft" | "submitted" | "late" | "returned" | "graded";

// A file attached to a submission. `viewUrl` is a short-lived signed URL (the
// object is private, never public); null only when signing failed. `fileSize`
// is bytes.
export type HomeworkSubmissionFile = {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  viewUrl: string | null;
  uploadedAt: string;
};

// The student's own submission for an assignment (draft or submitted). Absent
// (null on the detail payload) until the student first saves a draft or attaches
// a file. `status` here is the raw DB state (never the derived "not_submitted"/
// "late"); the assignment-level `status`/`late` fields carry the display state.
export type HomeworkSubmission = {
  id: string;
  status: "draft" | "submitted" | "returned" | "graded";
  textResponse: string | null;
  submittedAt: string | null;
  updatedAt: string;
  files: HomeworkSubmissionFile[];
};

// One assignment as shown in the class-detail "Homework" list — enough to
// render a row with its status without opening it. `status` is the derived
// display state (see HomeworkSubmissionStatus); `late` is broken out so a
// "submitted" row can also show a late flag.
export type HomeworkAssignmentSummary = {
  id: string;
  title: string;
  dueAt: string | null;
  status: HomeworkSubmissionStatus;
  late: boolean;
  // Whether the student currently has any files attached (draft or submitted).
  fileCount: number;
};

// Full assignment detail for the submission screen: the assignment itself plus
// the student's own submission (or null). `canSubmit`/`canEdit` are resolved
// server-side from the assignment's late/resubmission rules and the current
// submission status, so the client never re-derives the policy.
export type HomeworkAssignmentDetail = {
  id: string;
  bookingId: string;
  title: string;
  instructions: string | null;
  dueAt: string | null;
  allowLateSubmission: boolean;
  allowResubmission: boolean;
  // Derived display state + late flag (same as the summary), for the header.
  status: HomeworkSubmissionStatus;
  late: boolean;
  // Whether the due date has already passed (for the "past due" hint).
  pastDue: boolean;
  // Whether a final submit is currently allowed (not already submitted without
  // resubmission, and not past due when late submission is disallowed).
  canSubmit: boolean;
  // Whether the student may still edit text / add / remove files.
  canEdit: boolean;
  submission: HomeworkSubmission | null;
  // The teacher's feedback on the most recent attempt, once given — null until
  // then. Never a draft/undecided AI review, only an explicit teacher decision.
  feedback: HomeworkFeedback | null;
};

// Teacher-facing assignment row (create/list/delete on the teacher class
// screen). `submissionCount` is how many students have a non-draft submission —
// a lightweight signal for the future review surface.
export type TeacherAssignment = {
  id: string;
  bookingId: string;
  title: string;
  instructions: string | null;
  dueAt: string | null;
  allowLateSubmission: boolean;
  allowResubmission: boolean;
  createdAt: string;
  submissionCount: number;
};

// An immutable snapshot of one submit action (HomeworkAttempt). `files` mirrors
// HomeworkSubmissionFile's wire shape but scoped to just this attempt.
// `feedback` is this attempt's own HomeworkFeedback (null until a teacher
// reviews it) — nested here rather than fetched separately since a teacher
// reviewing attempt history wants both in the same screen.
export type HomeworkAttempt = {
  id: string;
  attemptNumber: number;
  textResponse: string | null;
  submittedAt: string;
  files: HomeworkSubmissionFile[];
  feedback: HomeworkFeedback | null;
  // Most-recent-first. Empty until a teacher taps "Review with AI" at least
  // once; "Regenerate" appends rather than replaces (slice 5).
  aiReviewDrafts: HomeworkAiReviewDraft[];
};

// The teacher's decision on one attempt. Maps onto HomeworkSubmissionStatus:
// approved -> graded; the other two -> returned (re-opens the submission for
// editing regardless of the assignment's allowResubmission default).
export type HomeworkFeedbackDecision = "approved" | "resubmission_requested" | "rejected";

// The teacher's response to one attempt — only ever visible to the student
// once created (an approve/reject/request-resubmission is a single action,
// there's no separate "publish" step). `score` is points out of
// HOMEWORK_FEEDBACK_MAX_SCORE (product sign-off, slice 4) — optional, a
// teacher can give pure written feedback with no number.
export type HomeworkFeedback = {
  id: string;
  decision: HomeworkFeedbackDecision;
  content: string;
  score: number | null;
  createdAt: string;
};

// Points-out-of-N scale for HomeworkFeedback.score (slice 4 product sign-off).
export const HOMEWORK_FEEDBACK_MAX_SCORE = 10;

// Body for creating feedback on one attempt (POST teacher/attempts/:id/feedback).
export type CreateHomeworkFeedbackInput = {
  decision: HomeworkFeedbackDecision;
  content: string;
  // Points out of HOMEWORK_FEEDBACK_MAX_SCORE; omit/null for no score.
  score?: number | null;
};

// Structured output of a homework AI review (docs/features/homework.md) —
// corrections/strengths/weaknesses are short bullet strings, not
// per-span annotations (no inline-comment UI exists yet); `suggestedScore` is
// points out of HOMEWORK_FEEDBACK_MAX_SCORE, same scale as the teacher's own
// score. Never shown to the student directly.
export type HomeworkAiReviewContent = {
  corrections: string[];
  strengths: string[];
  weaknesses: string[];
  grammarNotes: string[] | null;
  suggestedFeedback: string;
  suggestedScore: number | null;
};

// A teacher-triggered "Review with AI" / "Regenerate" draft. NEVER sent to the
// student — only what a teacher explicitly turns into a HomeworkFeedback is.
export type HomeworkAiReviewDraft = {
  id: string;
  instructions: string | null;
  content: HomeworkAiReviewContent;
  model: string;
  createdAt: string;
  discardedAt: string | null;
};

// Lesson insights — Phase C/E focus areas.
// The teacher validates AI-suggested findings (confirm / edit / dismiss) and adds
// her own. Wire shape exposes `confirmed`/`dismissed` booleans, never the raw
// timestamps. Voice-derived content rides the per-pair consent gate (D-22).
export type InsightCategory =
  "pronunciation" | "grammar" | "vocabulary" | "fluency" | "comprehension";

export type LessonInsight = {
  id: string;
  category: InsightCategory;
  summary: string;
  evidence: string | null;
  suggestion: string | null;
  source: "ai" | "teacher";
  confirmed: boolean;
  dismissed: boolean;
  skill: string | null;
};

// Speaking-time / participation analytics (D-97), one lesson's worth — see
// lib/lesson-notes/speaking-time.ts on the web side for how this is derived.
export type SpeakingTimeSummary = {
  totalMs: number;
  teacherSpeakingMs: number;
  studentSpeakingMs: number;
  teacherSharePct: number;
  studentSharePct: number;
};

export type StudentProgressTeacher = {
  teacherId: string;
  teacherName: string;
  improving: string[];
  practise: string[];
};

// Pre-class brief (Phase F1) — generated on demand from the profile. `focus`
// cues are plain teacher-voice text the teacher can stage into the live notes.
export type BriefFocus = {
  skill: string;
  category: InsightCategory;
  why: string;
  suggestedCue: string;
};

// Level-gated material library (docs/features/library-materials.md). The base
// student-facing material shape; the student surface (StudentLibrary) wraps it
// with tags + source and organizes by category.
export type LibraryEntry = {
  id: string;
  label: string | null;
  unit: string | null;
  levelLabel: string;
  attachmentKind: MaterialAttachmentKind;
  viewUrl: string | null;
  // Markdown source when the item carries native content (D-20, Layer 4); null
  // otherwise. Rendered natively, never as raw HTML. A unified item may carry
  // this AND a file AND a link — `fileUrl`/`linkUrl` expose the other pieces.
  body?: string | null;
  fileUrl?: string | null;
  linkUrl?: string | null;
  // True when the file piece is a raster image (derived from the stored
  // filename — no MIME type is persisted; see material-file-kind.ts). Lets a
  // client show the picture inline instead of a bare "open this" link, which
  // is the whole point for a visual learner. Absent/false = render the link.
  isImage?: boolean;
  // A short signed URL to the material's generated podcast audio (mp3), present
  // only when a podcast has been generated and is ready. Null/absent otherwise.
  podcastUrl?: string | null;
  // Estimated podcast length in seconds, for a "· 4:12" style duration label.
  podcastDurationSec?: number | null;
  // Present on assigned items only: whether the teacher marked it covered.
  completed?: boolean;
};

// Where a student-facing material reaches the student from. Shown as a small
// source chip so category grouping doesn't erase the "your teacher assigned
// this" / "from your class" distinction.
export type StudentMaterialSource = "browse" | "assigned" | "class";

// A material as it appears in the student's organized library: the base entry
// plus its tags (for chips AND category grouping) and its source.
export type StudentMaterialEntry = LibraryEntry & {
  tags: MaterialTag[];
  source: StudentMaterialSource;
  // For source === "class": the class's start time (ISO) the item was attached
  // to, so the student sees which class it came from. Null/absent otherwise.
  classStartsAt?: string | null;
};

// A category bucket in the student's organized materials list. `categoryId`
// null is the trailing "uncategorized" bucket (see groupMaterialsByCategory).
export type StudentMaterialCategoryGroup = {
  categoryId: string | null;
  categoryLabel: string;
  items: StudentMaterialEntry[];
};

export type StudentLibrary = {
  // Whether the teacher has placed the student at a level. When false the
  // level-browse library is empty — a level-less student sees no level-gated
  // materials at all, only what a teacher explicitly assigned or attached to a
  // class. Drives the empty-state copy.
  hasLevel: boolean;
  // The student's own level label with this teacher (e.g. "B1"), for showing
  // "your level" to the student. Null when unset (hasLevel === false).
  levelLabel: string | null;
  // Every material the student can see — level-browse, notebook-assigned, and
  // class-attached — deduped and organized into one set of category groups
  // (groupMaterialsByCategory), each item carrying its level + source for
  // display. Empty array = nothing to show.
  categories: StudentMaterialCategoryGroup[];
};

// Teacher-side library management (the web /dashboard/materiales page).
// `visibility` controls who sees a level-tagged item: `at_or_below` (the
// student's level and below), `exact` (only that level), `all` (everyone).
export type LibraryVisibility = "at_or_below" | "exact" | "all";

export type LibraryMaterialAdmin = {
  id: string;
  levelId: string;
  levelLabel: string;
  visibility: LibraryVisibility;
  unit: string | null;
  label: string | null;
  attachmentKind: MaterialAttachmentKind;
  viewUrl: string | null;
  // As on CallMaterial: set only for a "file" row, and only so the in-call
  // library tab can hand a picked row to the same viewer the class tab does
  // (see toCallMaterial). Derived from the storage path server-side — the
  // client holds the signed URL, whose query string is not a filename.
  fileKind: MaterialFileKind | null;
  // Markdown source + provenance when attachmentKind === "content" (D-20,
  // Layer 4; source added for the unified-form parity pass so a client can
  // edit a content item in place the same way the web MaterialForm does).
  body?: string | null;
  source?: ClassContentSource | null;
  archived: boolean;
  // Gap G1 (docs/features/library-materials.md) — the teacher's existing
  // category/format/theme taxonomy (same rows as ClassContentFocusGroup),
  // tagged onto this material. Ids reference the teacher's own FocusTagRow.
  focusTagIds: string[];
};

export type TeacherLibraryLevel = { id: string; label: string };

// GET /api/teacher/library/materials — one keyset page of the library list,
// server-filtered/sorted. Drives the in-call library tab's infinite scroll:
// pass the prior page's `nextCursor` (null/absent for the first page) plus the
// active filters + sort. `nextCursor === null` means the end.
export type TeacherLibraryMaterialsPage = {
  items: LibraryMaterialAdmin[];
  nextCursor: string | null;
};

// GET /api/teacher/library/filters — just enough to draw the filter chips
// above that list. Deliberately the two fields the picker reads and nothing
// else: TeacherLibrary above is the whole-screen bootstrap, and a picker that
// asked for it would pay for a materials page, a template list and an
// entitlements load it throws away.
export type TeacherLibraryFilterMeta = {
  levels: TeacherLibraryLevel[];
  focusGroups: ClassContentFocusGroup[];
};

// The current podcast state for a material, as the teacher-facing status/poll
// endpoints return it. "none" = never requested; url is a signed playback URL
// present only when ready.
export type MaterialPodcastStatus = {
  status: "none" | "pending" | "ready" | "failed";
  url: string | null;
  durationSec: number | null;
  error?: string | null;
};

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentStatus = "pending" | "paid" | "failed" | "refunded" | "partially_refunded";

// The payout rail a payment ran on (D-113). `manual_transfer` is "the student
// followed payee instructions and the teacher confirmed"; WHICH instructions
// is `instrumentKind`/`instrumentId`, because the instrument is data and not
// a provider.
export type PaymentMethod = "stripe" | "manual_transfer";

// What a payment settled as, for display and analytics. The manual values are
// exactly PayoutInstrumentKind, so a rail breakdown is an instrument
// breakdown with no join.
export type PaymentRail = "card" | "wise" | "bank_transfer" | "unknown";

export type Payment = {
  id: string;
  createdAt: string;
  status: PaymentStatus;
  amountCents: number;
  // ISO-4217 code recording what `amountCents` is denominated in — the
  // teacher's own pricing currency (D-64/D-124), which is any of ~40 curated
  // codes, not necessarily MXN. Typed as string rather than a literal union so
  // it carries the row's real stored currency for provenance.
  currency: string;
  method: PaymentMethod;
  // Which payee instructions the student was shown. Null for `stripe`, and
  // for a manual payment whose instrument row was removed.
  instrumentKind: PayoutInstrumentKind | null;
  externalRef: string;
  studentName: string;
  studentId: string;
  packageTemplateName: string;
  packageId: string | null;
  classesUsed?: number;
  classesTotal?: number;
};

// The teacher's cashflow summary — mirrors
// `CashFlowSummary` from apps/web/src/lib/cashflow.ts field-for-field (the
// teacher's earned-vs-held split, computed on her actual net post-commission
// where known — see D-58 marketplace-commission pivot).
export type CashFlowSummary = {
  totalPaidCents: number;
  earnedCents: number;
  heldCents: number;
  heldLessons: number;
  safeMonthlySpendCents: number;
  provisionalMonths: number;
  currentMonthEarnedCents: number;
  currentMonthLessons: number;
};

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export type StudentSummary = {
  id: string;
  name: string;
  email: string;
  customPriceCents: number | null;
  // Currency of `customPriceCents` (ISO-4217) — the teacher's own pricing
  // currency (D-64/D-124). Carried explicitly so the amount's denomination is
  // never implicit.
  currency: string;
  // true when the teacher created the student manually and hasn't gone live yet
  // (onboardingHoldAt is set); notifications are suppressed until go-live.
  notLive: boolean;
  archivedAt: string | null;
  level: { id: string; label: string } | null;
  activePackage: {
    name: string;
    remaining: number;
    total: number;
    expiresAt: string | null;
  } | null;
};

// The signed-in student's own contact card. Email is read-only on this
// surface — it's
// the magic-link sign-in identity, so changing it needs a verified flow.
export type StudentProfile = {
  name: string;
  email: string | null;
  phoneE164: string | null;
  timezone: string | null;
  // Live-caption default (D-27): the student's own language. See
  // caption-languages.ts. Overridable per class by the teacher.
  nativeLanguage: string;
};

export type UpdateStudentProfileBody = {
  name: string;
  // null clears the number.
  phoneE164: string | null;
  // ISO-3166-1 alpha-2, picked next to the phone field — resolves a bare
  // national-format phoneE164 to the right calling code. Ignored when
  // phoneE164 is null.
  phoneCountry?: string;
  // Omitted = leave unchanged.
  timezone?: string;
  // Omitted = leave unchanged.
  nativeLanguage?: string;
};

// Teacher notification preferences.
export type TeacherNotificationPrefs = {
  notificationPrefs: Record<string, boolean>;
  channelPrefs: Record<string, string[]>; // category → channel list
  emailOptIn: boolean;
  pushOptIn: boolean;
  hasPushDevice: boolean;
};

// ---------------------------------------------------------------------------
// Availability + blocked dates
// ---------------------------------------------------------------------------

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type WeeklyAvailability = {
  weekday: Weekday;
  startMinutes: number;
  endMinutes: number;
};

export type BlockedDate = {
  id: string;
  fromDate: string;
  toDate: string;
};

export type Slot = {
  startsAt: string;
  endsAt: string;
};

// ---------------------------------------------------------------------------
// Booking-page tools: leads + testimonials (the "Tu página" group)
// ---------------------------------------------------------------------------

export type LeadStatus = "new" | "contacted" | "converted" | "archived";

// Inbound enquiry from the public booking page — the `/dashboard/leads` row.
export type Lead = {
  id: string;
  name: string;
  email: string;
  phoneE164: string | null;
  message: string | null;
  status: LeadStatus;
  createdAt: string;
};

// Teacher-authored social proof shown on the public booking page. See
// [D-151](../../../docs/decisions/D-151.md) for the two `source` kinds and why
// a teacher can never author a verified one.
export type Testimonial = {
  id: string;
  authorName: string;
  authorNote: string | null;
  body: string;
  published: boolean;
  // Optional author avatar public URL. Null when no photo has been uploaded.
  // The server resolves the storage path to a URL before returning; the
  // client never sees a raw storage key. Uploaded via multipart form — web
  // dashboard action.
  photoUrl: string | null;
};

// Body for creating/editing a testimonial.
// photoPath is handled via multipart upload separately — not included here.
export type TestimonialInput = {
  authorName: string;
  authorNote?: string;
  body: string;
};

// Body for creating/editing a share group.
export type ShareGroupInput = {
  name: string;
  url?: string;
};

// ---------------------------------------------------------------------------
// Discount codes + referrals (teacher-funded promos, slice 2a/2b)
// ---------------------------------------------------------------------------

export type DiscountKind = "percent" | "fixed";

// A teacher promo code as shown on the discounts screen. `percentBps` is
// basis points (1500 = 15%);
// `amountMinorUnits` is a flat reduction in the teacher's own currency's minor
// units (see `currency` below); exactly one is set per
// `kind`. `usedCount` counts redemptions whose purchase is still live.
export type DiscountCode = {
  id: string;
  code: string;
  kind: DiscountKind;
  percentBps: number | null;
  amountMinorUnits: number | null;
  // Currency of the fixed `amountMinorUnits` — the teacher's own pricing
  // currency (D-64/D-124), carried explicitly.
  currency: string;
  active: boolean;
  maxRedemptions: number | null;
  perStudentLimit: number;
  expiresAt: string | null; // YYYY-MM-DD
  usedCount: number;
};

// One reward side in a referral-program save body.
export type ReferralRewardInput = {
  kind: DiscountKind;
  percent?: number;
  amountPesos?: number;
};

// Body for saving the referral program.
export type ReferralProgramInput = {
  enabled: boolean;
  referred: ReferralRewardInput;
  referrer: ReferralRewardInput;
  rewardExpiryDays?: number | null;
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

import type { NotificationChannel } from "./notifications";

export type NotificationStatus = "queued" | "sent" | "delivered" | "failed";

export type Notification = {
  id: string;
  templateKey: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  language: LocaleCode;
  createdAt: string;
  error: string | null;
};

// Mirrors Prisma's `IntroVideoAnalysisStatus` enum as a plain string union —
// this file ships into the client bundle, so it can't depend on @prisma/client.
export type IntroVideoAnalysisStatus = "pending" | "transcribing" | "transcribed" | "failed";

// Structured AI coach feedback on a teacher's intro video (D-73, Layer 3). The
// coach reviews the transcript and returns a warm overall take plus concrete
// strengths and actionable improvements (length, missing hooks — who it's for,
// price — energy). Built by a pure prompt over the transcript; teacher-only.
export type IntroCoachFeedback = {
  overall: string;
  strengths: string[];
  improvements: string[];
};

// AI material style settings (teacher-configurable tone/register for generated
// materials). Deliberately its own small resource rather than part of the
// account body, so the "AI material style" surface owns exactly what it edits.
// `null` = unset (today's default behaviour). See `materialStyleSchema` for
// validation bounds.
export type MaterialStyleSettings = {
  tone: MaterialTone | null;
  learnerAge: MaterialLearnerAge | null;
  languageVariety: string | null;
  customInstructions: string | null;
  // Teacher default vocabulary difficulty (D-80), a separate axis from the CEFR
  // level. `null` = the effective default (everyday). Applied to every AI
  // generation path via resolveSubject, and overridable per class.
  vocabulary: MaterialVocabulary | null;
};

// Live availability for the booking-slug editor (the "enlace de reservas").
// Advisory — the PATCH write's unique constraint is the real gate. "current" =
// the teacher's own slug; "invalid" carries the same reason keys the offline
// validator returns; "taken" also offers a few free alternatives (social-handle
// style) the client can render as one-tap chips.
export type BookingSlugAvailability =
  | { status: "current"; slug: string }
  | { status: "available"; slug: string }
  | { status: "taken"; slug: string; suggestions: string[] }
  | { status: "invalid"; reason: "too-short" | "reserved" };

// ---------------------------------------------------------------------------
// In-portal repurchase (signed-in "buy another package")
// ---------------------------------------------------------------------------

// The instrument as the checkout picker needs it: enough to label the option
// and to name it back to the server. Payee details themselves are NOT here —
// they belong to the instructions screen, which the student only reaches after
// a payment row exists.
export type StudentBuyInstrument = {
  id: string;
  kind: PayoutInstrumentKind;
};

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type AdminStats = {
  teachers: number;
  teachersOnboarded: number;
  students: number;
  activePackages: number;
  overrides: number;
  openDisputes: number;
  grossPaidCents: number;
  refundsCents: number;
  notificationsQueued: number;
  notificationsFailed: number;
};

// --- Admin: staff (admin_users management) ---
export type AdminRole = "superadmin" | "finance" | "support";

// ---------------------------------------------------------------------------
// Subscriptions / monetization (docs/features/subscriptions.md)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export type ChatMessageReaction = {
  role: "teacher" | "student";
  emoji: string;
};

// Denormalized preview of the message a reply points at, so the client can
// render the quoted snippet without a second fetch. `null` when the message
// isn't a reply, or when its replyToId pointed at a message no longer
// resolvable (deleted the row itself — a deleted-for-everyone tombstone is
// still resolvable and reported via its own placeholder body).
/**
 * What a message IS, decided from the stored columns rather than from a signed
 * URL — a URL that failed to mint would otherwise turn a voice note back into
 * a text message. Named once here because three surfaces phrase a message by
 * its kind: the quoted reply snippet, the clipboard placeholder, and the
 * thread-list preview.
 */
export type ChatMessageKind = "text" | "voice" | "video" | "image" | "file";

export type ChatMessageReplyPreview = {
  id: string;
  body: string | null;
  senderRole: "teacher" | "student";
  kind: ChatMessageKind;
};

export type ChatMessage = {
  id: string;
  senderRole: "teacher" | "student";
  body: string | null; // null for voice-only, video-only, image-only, or file-only messages
  replyToId: string | null;
  replyPreview: ChatMessageReplyPreview | null;
  voiceUrl: string | null; // signed URL (~24h TTL); null for non-voice messages
  voiceDurationMs: number | null;
  videoUrl: string | null; // signed URL (~24h TTL); null for non-video messages
  videoDurationMs: number | null;
  imageUrl: string | null; // signed URL (~24h TTL); null for non-image messages
  imageWidth: number | null;
  imageHeight: number | null;
  fileUrl: string | null; // signed URL (~24h TTL); null for non-file messages
  fileName: string | null;
  fileSizeBytes: number | null;
  fileMimeType: string | null;
  createdAt: string; // ISO 8601
  readAt: string | null; // ISO 8601, null = unread by recipient
  editedAt: string | null; // ISO 8601, set when the sender edited the body
  // ISO 8601 "delete for everyone" tombstone. When set, body/media fields are
  // null — clients render a localized "This message was deleted" in place.
  deletedAt: string | null;
  // Up to one reaction per thread participant (WhatsApp semantics — see
  // toggleMessageReaction in lib/chat/message-actions.ts).
  reactions: ChatMessageReaction[];
};

export type ChatThread = {
  studentId: string;
  studentName: string;
  lastMessage: ChatMessage | null;
  /**
   * The kind of `lastMessage`, carried separately because a thread summary
   * does NOT mint signed media URLs — one per row would be a storage round
   * trip per conversation just to draw a list. Without it every attachment in
   * the list previewed as "voice message", which is what the teacher-facing
   * list actually did: the query selected the voice path and nothing else.
   */
  lastMessageKind: ChatMessageKind | null;
  unreadCount: number;
};

export type StudentChatThread = {
  teacherId: string;
  teacherName: string;
  studentId: string;
  lastMessage: ChatMessage | null;
  /** See ChatThread.lastMessageKind. */
  lastMessageKind: ChatMessageKind | null;
  unreadCount: number;
};

// --- Student acquisition (D-125) ---
//
// The wire shapes for the acquisition surfaces. Labels and reason sentences
// are rendered SERVER-side (from the shared pure helpers in ./marketing) rather
// than shipped as codes for a client to phrase itself — duplicating that copy
// per client is exactly the drift this package exists to prevent, and a reason
// sentence that read differently on the
// two platforms would make one plan look like two.

export type MarketingActivity = {
  id: string;
  kind: string;
  kindLabel: string;
  kindSummary: string;
  platform: string;
  platformLabel: string;
  status: "planned" | "ready" | "done" | "skipped";
  title: string | null;
  body: string | null;
  angleNote: string | null;
  reasonText: string | null;
  /** The short tracked link, when this action carries one at all. */
  trackedLink: string | null;
  imageUrl: string | null;
  communityName: string | null;
  communityUrl: string | null;
  studentName: string | null;
  results: { visits: number; enquiries: number; students: number };
  createdAt: string;
};

export type MarketingProfileInput = {
  audiences: string[];
  learnerLocations: string[];
  levels: string[];
  differentiator?: string;
  weeklyMinutes: number;
  goalNewStudentsPerMonth: number;
};
