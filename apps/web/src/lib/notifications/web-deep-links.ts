// Deep-link path suffix → web pathname.
//
// The dispatcher emits ONE path suffix per notification (`urlButtonSuffix`),
// reused by the email CTA, the push payload, and the in-app inbox. Most
// suffixes are already web paths (`dashboard/classes/<id>`, `payments/<id>`,
// `settings/billing`), so they need no translation.
//
// The chat/class/book suffixes are the exception: they carry a ROLE PREFIX —
// `s/` (student) or `t/` (teacher) — a role marker carried in the notification
// payload. Those prefixes are not web routes; the
// web app partitions the same screens by route group instead
// (`/dashboard/*` for teachers, `/my-classes/*` for students).
//
// Rooting a role-prefixed suffix at "/" therefore produces a 404 — which is
// exactly why a message notification in the web inbox went nowhere: its
// suffix `t/messages/<studentId>` became `/t/messages/<studentId>` instead of
// `/dashboard/messages/<studentId>`.

// The role-prefixed suffixes the dispatcher emits, each optionally followed by
// one id segment.
const TEACHER_CHAT = "t/messages";
const STUDENT_CHAT = "s/messages";
const STUDENT_CLASS = "s/class";
const STUDENT_BOOK = "s/book";

// Match `prefix` at the head of `path`, returning the remaining segment(s)
// ("" when the suffix is the bare prefix) or null when it doesn't match.
// Anchored on a "/" boundary so `s/classroom` can never match `s/class`.
function afterPrefix(path: string, prefix: string): string | null {
  if (path === prefix) return "";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length + 1);
  return null;
}

/**
 * Turn a dispatcher path suffix into an in-app web pathname, or null when
 * there's nothing to link to. Absolute URLs pass through untouched.
 *
 * Every leading slash is stripped before re-rooting, so a suffix can never
 * produce a protocol-relative "//host" URL that would escape the origin.
 */
export function webPathForDeepLink(suffix: string | null | undefined): string | null {
  if (!suffix) return null;
  if (/^https?:\/\//i.test(suffix)) return suffix;

  const path = suffix.replace(/^\/+/, "");
  if (!path) return null;

  // Teacher ↔ student chat threads. Both web pages are per-conversation
  // server routes, so linking straight at the id both opens the messaging
  // surface and selects the right conversation — no client-side selection
  // step, and it behaves the same coming from any page.
  const studentId = afterPrefix(path, TEACHER_CHAT);
  if (studentId !== null) {
    return studentId ? `/dashboard/messages/${studentId}` : "/dashboard/messages";
  }

  const teacherId = afterPrefix(path, STUDENT_CHAT);
  if (teacherId !== null) {
    return teacherId ? `/my-classes/messages/${teacherId}` : "/my-classes/messages";
  }

  // Student class detail + book tab — same role-prefix problem as chat.
  const bookingId = afterPrefix(path, STUDENT_CLASS);
  if (bookingId !== null) {
    return bookingId ? `/my-classes/${bookingId}` : "/my-classes";
  }

  if (afterPrefix(path, STUDENT_BOOK) !== null) return "/my-classes/book";

  // Everything else is already a web path.
  return `/${path}`;
}
