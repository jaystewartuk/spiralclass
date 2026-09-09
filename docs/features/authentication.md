# Authentication

## Overview

SpiralClass is fully passwordless. There is no password field anywhere in the
product. Signing in means proving control of an email
address (via a one-time 6-digit code sent by email) or signing in with a
Google account. Once signed in, teachers, students, and platform staff each
land in a different part of the app depending on their role, and staff
accounts have an additional, mandatory second-factor check before they can
use any admin capability.

Students can also arrive at the product without ever "signing up" in the
traditional sense: a teacher can add them to a roster (by hand or by CSV
import) before they've ever visited the site, or a student can create their
own record simply by buying a class through a teacher's public booking page.
Either way, the first time that email address is used to sign in, the system
links it to the right student record automatically.

## User Stories

- As a new teacher, I want to sign up with just my name and email so I can
  start setting up my booking page without creating or remembering a
  password.
- As a returning teacher or student, I want to sign in with a 6-digit code
  emailed to me (or with my Google account) so I never have to remember a
  password.
- As a student who was added to a teacher's roster (by hand or CSV import)
  but never bought anything, I want to accept an invitation email and land
  signed in to my own account, without accidentally creating a second,
  unlinked account.
- As a student who buys a class from a teacher's public booking page without
  being signed in, I want the checkout to recognize my email so that my
  purchase and any future sign-in resolve to the same account.
  & As a student, I want to click a "notification settings" link in an email
  and land in my account settings signed in, without re-entering a code.
- As a platform staff member (admin), I want a stronger identity check than a
  plain email code before I can view or act on sensitive account/payment
  data.
- As any user, I want to be redirected safely after signing in — never to an
  external or malformed destination smuggled in via a link.
- As any user, I want to stay signed in between visits so I don't have to
  request a new code every time.

## Business Rules

**Sign-in code (email OTP)**

- The code is **6 digits**, valid for **5 minutes**, and delivered by email
  with no clickable link (code-only, must be typed in).
- Up to **3 incorrect attempts** are allowed against a given code before it
  is invalidated and a new one must be requested.
- The code auto-submits the instant a 6th digit is entered; a manual "verify"
  fallback appears after ~2.5 seconds if nothing has happened yet, or
  immediately on error.
- Requesting a sign-in code is rate-limited: per IP, **10 requests per 60
  seconds**; per email address, **3 requests per 5 minutes**.
- Verifying a code is rate-limited per IP: **10 attempts per 60 seconds**.
- Requesting a **sign-up** code has its own, stricter per-IP limit (**5 per 60
  seconds**) but the same per-email limit (3 per 5 minutes).
- Rate-limit responses never reveal whether an email address has an account
  (anti-enumeration) — the system always reports success on send, even
  internally failed sends.

**Sign-up vs. sign-in intent**

- Sign-up requires a **name and email**; sign-in requires only an email.
- A brand-new teacher account is only ever created through the sign-up
  intent. Typing an unrecognized email into the plain sign-in form never
  silently creates a teacher account — it returns a "no account found"
  message instead. This prevents someone mistyping an email, or a student's
  email, from accidentally becoming a teacher account.
- If someone tries to sign in or sign up with an email that already belongs
  to a teacher account under conditions that would create a conflicting
  identity, they see a clear conflict message rather than a silent failure.

**Google Sign-In**

- Google Sign-In is available only when the platform has Google credentials
  configured; otherwise, email code is the only sign-in method shown.
- A Google sign-in automatically links to an existing account that has the
  same, already-verified email address — no separate re-verification step is
  required. It never merges two accounts that have different email
  addresses.
- A Google account resolves to a person's account by Google's own stable
  account identifier, never by email address. This matters for what happens
  when someone changes their sign-in email — see the next section.

**Changing your sign-in email on a Google-linked account**

- Anyone who has ever signed in with Google has that Google account linked to
  their SpiralClass identity, separately from whatever email currently sits
  on the account.
- Changing your sign-in email (teacher or student, from the account settings
  page) always disconnects any linked Google account as
  part of the same change — this happens automatically, every time, whether
  or not the new address is itself a Gmail/Google address. This is what
  prevents an account takeover: without it, the ORIGINAL Google account
  would keep being able to sign in to the account forever, no matter what
  email was later set on it.
- Disconnecting Google never locks anyone out: the email code is always the
  underlying sign-in method for every account, Google or not, so an account
  with no Google connection at all still signs in normally.
- Every other active session for the account is also signed out at the same
  time as the email change (the device making the change stays signed in).
  This closes the case where a device was already signed in through the
  Google identity being disconnected.
- After the change, the settings page shows whether a Google account is
  currently connected and offers to (re)connect one. Reconnecting always
  requires actually signing in with a Google account — and that Google
  account's email must match the CURRENT sign-in email exactly, the same
  rule that governs linking Google to any account. In practice this means a
  person can only reconnect the Google account that matches their new
  address; picking a different Google account is rejected as a mismatch,
  and a Google account already connected to someone else's SpiralClass
  account is rejected as a duplicate.
- Reconnecting Google is entirely optional and has no deadline — nothing
  else about the account depends on it.
- An email change made by support on someone's behalf (the admin path used
  when the person also lost access to their old inbox) follows the exact
  same rule: any linked Google account is disconnected and every session for
  that account is signed out, since the currently-open session in that case
  belongs to the admin, not the account holder.

**Role resolution after sign-in**

- Immediately after verifying a code (or completing Google sign-in), the
  system decides where to send the person next:
  - Staff/admin account → the admin panel.
  - Teacher who hasn't finished onboarding → the onboarding flow.
  - Teacher who has finished onboarding → their dashboard (or a requested
    destination, if one was specified).
  - An email already linked to a student record → the student portal.
  - An email that matches an unclaimed student record on some teacher's
    roster → automatically linked to that record, then sent to the student
    portal.
  - An email that owns neither a teacher nor a linked student record, under
    sign-in intent → "no account found" message.
  - An email that owns neither, under sign-up intent → a brand-new teacher
    account is created and the person is sent to onboarding.
  - An email that already belongs to a teacher account, encountered via a
    path that would otherwise create/link a student → conflict message
    (teacher and student are mutually exclusive per sign-in identity).

**Linking a sign-in identity to a roster student record**

- A given email can be pre-created as a student record on a teacher's roster
  before anyone signs in (via manual entry, CSV import, or a first purchase).
- The very first time a matching, unclaimed email signs in, it is
  permanently linked to that student record. If more than one unclaimed
  record matches (e.g., duplicate roster entries), the **oldest** one is
  linked.
- An unclaimed record that is not on any teacher's roster is never
  auto-linked.
- Once a student record is linked to a sign-in identity, all future sign-ins
  by that email resolve to the same record — it cannot be re-linked
  elsewhere.
- This resolution logic is shared identically across the email-code and
  Google sign-in flows, so behaviour is consistent everywhere someone can sign
  in.

**Notification/action links that sign a user in without a code**

- Certain links sent in notifications (for example, an email or push
  notification's "manage notification settings" link) can land a signed-out
  person already signed in, without typing a code — the identity was already
  verified out of band (they received the notification at their own
  address/device). These links are short-lived (10 minutes) and single-use.
- If the link's target account differs from whoever is currently signed in
  on that device, the person is sent to sign in normally with the correct
  email pre-filled instead of being silently switched to the other account.
- **Open Question**: the exact full set of places this "trusted, no-code"
  sign-in path is used (beyond the notification-settings deep link) was not
  exhaustively confirmed against every caller in the codebase — treat any
  other use of it as needing verification before relying on it in a support
  or security context.

**Session behavior**

- Sessions are cookie-based. better-auth resolves a session from a request's
  headers the same way whether the credential arrives as a cookie or a bearer
  token, which is why route handlers and page routes share one session store.
- The middleware keeps a short (~60 second) optimistic cache of "am I signed
  in" to avoid extra checks on every request; the authoritative check still
  happens at the page level.
- There is no silent refresh-token renewal. A session stays valid until it
  expires on the server or is explicitly revoked — by sign-out, an admin
  action, or account deletion.

**Redirect safety**

- Any "continue to this page after signing in" destination is validated: it
  must be an internal path starting with a single `/`, contain no control
  characters, and not be a protocol-relative (`//`) or backslash-prefixed
  path — closing off tricks that could otherwise redirect to an external
  site after sign-in.

**Cross-origin protection**

- State-changing requests that rely on the signed-in cookie are checked for
  same-origin signals (the request must not be provably coming from another
  site). Webhook endpoints (which are verified by cryptographic signature
  instead) and simple page loads are exempt from this check.

**Admin two-factor authentication and "step-up" verification**

- Every staff/admin account, regardless of seniority, must enroll an
  authenticator-app (TOTP) second factor — there is no opt-out.
- Enrolling 2FA on the account is **not sufficient by itself** to use the
  admin panel. Because ordinary sign-in is just an emailed code, a
  compromised inbox alone could otherwise get past a check that only asked
  "is 2FA enabled?" To close that gap, an admin must additionally complete a
  fresh authenticator-code check ("step-up") during their current session; a
  successful step-up is valid for roughly **12 hours** before it must be
  repeated.
- Failing either check (2FA not enrolled, or enrolled but no recent step-up)
  sends the admin to the security/step-up screen — not into the admin panel.
- The one exception is the enrollment/step-up screen itself and the bare
  admin-shell layout, which only check "is this an admin at all," to avoid a
  redirect loop before someone has finished enrolling.
- A small number of staff accounts can be recognized as a temporary
  "bootstrap" superadmin via an environment-level email allowlist if no real
  staff records exist yet; this is meant to be a transient bootstrap state,
  not a permanent access path.

**Invite-only signup (alpha allowlist)**

- The product still carries a database table for an email allowlist from an
  earlier closed-beta period, but nothing in the current running code checks
  it. **Sign-up is not currently invite-only/allowlist-gated** for teachers
  or students. Treat any assumption that "only allowlisted emails can sign
  up" as outdated.

**CSV-imported / roster student first login**

- A student a teacher adds by hand or imports via CSV, who has never bought
  anything, can be sent an invitation email/link containing a unique,
  hard-to-guess token. That invitation:
  - Is valid for **30 days**.
  - Can be resent, but only once every **60 minutes** (resend cooldown).
  - Can be sent in bulk to up to **200** students at once.
  - Triggers a one-time reminder to the teacher if unaccepted after **3
    days**.
- Accepting the invitation requires the person clicking it to be (or become)
  signed in with an email that **exactly matches** the invited email —
  otherwise it is rejected as a mismatch. This is a deliberate anti-hijack
  check: someone else's session can't accept another person's invitation.
- If the invited email already belongs to a teacher account, acceptance is
  refused (the same teacher/student mutual-exclusivity rule as elsewhere).
- Accepting the invitation clears a hold the teacher's onboarding otherwise
  has on that student, and links the student record the same way any other
  sign-in linking does.
- A CSV-imported student never receives platform notifications by default —
  their notification preferences start fully switched off until they
  explicitly opt in themselves.
- A student can also be created purely by buying a class through a teacher's
  public booking page without any invitation at all; the email typed at
  checkout becomes their identity, and a sign-in code is automatically sent
  after purchase.

## User Flow

**Teacher sign-up**

1. Visit the sign-up page; enter name and email.
2. Receive a 6-digit code by email; enter it (auto-submits on the 6th
   digit).
3. Land in the onboarding flow (a fresh teacher account is created at this
   point, not before).

**Teacher/student sign-in (email code)**

1. Visit sign-in; enter email only.
2. Receive a 6-digit code by email (valid 5 minutes, 3 wrong tries allowed).
3. Enter the code; on success, land on the dashboard, onboarding, or student
   portal depending on account state.

**Google sign-in**

1. Choose "Sign in with Google".
2. Complete Google's own consent step.
3. Return to the app already signed in; the same role-based landing logic
   decides the destination.

**Buying a class without an account (public booking link)**

1. Open a teacher's public booking link — no sign-in required.
2. Choose a class package and enter payment details, typing an email address
   at checkout.
3. That email becomes (or is matched to) the student's identity; a sign-in
   code is sent automatically after purchase for future visits.
4. The result page offers to resend that sign-in code if needed.

**Roster invitation acceptance**

1. Teacher adds/imports a student and sends (or the system auto-sends) an
   invitation link.
2. Student opens the link.
3. Student signs in with the exact invited email.
4. Their account is linked to the pre-existing roster record and any
   onboarding hold on it is cleared.

**Admin sign-in and step-up**

1. Staff member signs in with an email code (or Google), same as anyone
   else.
2. If not yet enrolled in 2FA, they're routed to the security page to enroll
   an authenticator app.
3. To actually use the admin panel, they must additionally complete a fresh
   authenticator-code check; this "step-up" is remembered for about 12
   hours, after which it must be repeated.

## Data Used

- **Sign-in identity**: an email address, a display name, whether the email
  has been verified, and whether two-factor authentication is enrolled.
- **Sign-in code**: a temporary, single-purpose 6-digit value with an
  expiry, tied to a specific email and purpose (sign-in, email verification,
  password-adjacent flows are unused since there are no passwords, email
  change confirmation).
- **Session**: which device/browser is signed in as which identity, when it
  expires, and (for admins) whether a recent second-factor "step-up" proof
  exists.
- **Teacher record**: onboarding status, locale, and the operational
  settings created once someone becomes a teacher.
- **Student record**: whether it's linked to a sign-in identity yet, which
  teacher's roster it belongs to, and its own notification preferences.
- **Invitation**: an invited email, its expiry, how many times it's been
  resent, and its current status (pending/accepted/cancelled).
- **Admin/staff record**: role/seniority tier and whether the account is
  disabled.

## Edge Cases

- Same email is on more than one teacher's roster as separate, unclaimed
  student records: the oldest one wins the link; the others remain
  unclaimed for that identity.
- A person signs in with an email that already owns a teacher account, in a
  context that would otherwise try to create/link a student — blocked with a
  conflict message rather than silently merging two identities.
- Two requests race to link the same unclaimed student record at the same
  moment: the system resolves this safely so only one link wins; the other
  request re-reads and returns the same, now-linked record rather than
  creating a duplicate.
- A student's invitation is accepted by a different signed-in identity than
  the one invited — rejected outright, not silently linked.
- An invitation is accepted twice by the same (correct) identity — treated
  as already done, not an error.
- A sign-in code's 5-minute window expires before it's entered — must
  request a new one.
- A code is mistyped 3 times — invalidated; a new code must be requested.
- Someone requests codes rapidly enough to hit the per-IP or per-email
  rate limit — asked to wait, without being told whether the email has an
  account.
- A staff account enrolls 2FA but its "step-up" proof has expired (~12
  hours old) — sent back to the security screen to re-verify, even though
  2FA is "on."
- A `?next=` redirect parameter after sign-in is malformed, external, or
  contains suspicious characters — ignored/rejected in favor of a safe
  default destination.
- A notification/action link that signs someone in "for free" is clicked by
  a different person than intended (e.g., forwarded email) — since the link
  is single-use and short-lived (10 minutes), a second click, or a click
  after 10 minutes, will not silently succeed.
- A teacher or student who originally signed up with Google changes their
  sign-in email to something else entirely: the linked Google account is
  disconnected as part of that same change, so the original Google account
  can never sign back in to the account, no matter what email now sits on
  it — this is a deliberate security property, not an edge case that could
  slip through.
- Someone tries to reconnect Google after an email change but picks a
  different Google account than the one matching their current email —
  rejected as a mismatch, not silently linked.
- Someone tries to connect a Google account that's already connected to a
  different SpiralClass account — rejected as already in use, not silently
  merged or duplicated.
- Someone cancels the Google sign-in/consent screen partway through a
  reconnect attempt — treated the same as any other cancelled Google flow:
  no error, nothing changes, they land back where they started.

## Error States

- "No account found" — sign-in attempted with an email that owns neither a
  teacher account nor a linked/linkable student record.
- "Teacher email conflict" — the email already belongs to a teacher account
  and can't also become/link to a student, or vice versa.
- "Different account" — a trusted link (e.g., notification settings) points
  at an account other than the one currently signed in on this device.
- Too many requests — rate limit hit on requesting or verifying a code;
  asked to wait and retry later.
- Invalid or expired code — wrong code entered (up to 3 tries) or the
  5-minute window passed; must request a new code.
- Invitation errors — expired, already accepted by someone else, or the
  signed-in email doesn't match the invited email.
- Admin blocked at the door — signed in successfully but redirected to the
  2FA enrollment/step-up screen instead of the admin panel because 2FA isn't
  enrolled or the step-up proof is missing/stale.
- Email delivery failure — if the code email genuinely fails to send, the
  system surfaces an error rather than pretending success (distinct from the
  deliberate anti-enumeration behavior for "does this email have an
  account").

## Permissions

- **Anyone (signed out)**: can view a teacher's public booking page, buy a
  class from it, request a sign-in code, and use Google Sign-In.
- **Teacher**: can sign in/manage their own account only; cannot view or
  access another teacher's dashboard or students.
- **Student**: can sign in/manage their own account only; a given sign-in
  identity is linked to exactly one student record per teacher relationship.
- **Staff/Admin**: can access the admin panel only after 2FA enrollment and
  a fresh step-up check; different staff seniority tiers (see
  `user-roles.md`) gate different admin capabilities.
- No one can self-assign or elevate their own role (teacher, student, or
  admin) — role is always a consequence of which record their identity gets
  linked/created against, decided by the system's resolution rules above.

## Open Questions

- The exhaustive list of callers of the "trusted, no-code" sign-in link
  mechanism (beyond the notification-settings deep link) was not fully
  confirmed — flagging rather than guessing at its full surface area.
- Whether the vestigial alpha-allowlist database table is intended to be
  revived for a future invite-only phase, or should be removed as dead
  infrastructure, is not something the code answers.
- The exact conditions/env configuration needed for the "bootstrap
  superadmin" allowlist path to be active in production versus already
  fully retired were not independently verified beyond the code's own
  comments describing it as transitional.
