# Authentication

Sign-in is passwordless: a 6-digit code emailed to the address, or Google.
Auth is better-auth (`lib/auth/server.ts`) with its email-OTP plugin. After
sign-in each person lands by role — teacher, student or staff — and staff must
also pass a TOTP step-up before any admin page.

A student usually exists before she ever signs in: a teacher adds or invites
her, or she buys through a public booking page. Her first sign-in with that
email links her identity to that record.

## Sign-in code

- 6 digits, valid **5 minutes**, **3** wrong attempts before it is invalidated
  (`otpLength`, `expiresIn`, `allowedAttempts` in `lib/auth/server.ts`). The
  email carries the code only, no link.
- The field submits on the sixth digit; a manual verify button appears if
  nothing has happened after a short wait, or at once on error.
- Rate limits (`app/actions/auth.ts`). These are code defaults; each can be
  overridden per environment with `RATE_LIMIT_<SCOPE>` and
  `RATE_LIMIT_<SCOPE>_WINDOW_MS` (`lib/rate-limit.ts`):

  | Scope             | Keyed by | Default     |
  | ----------------- | -------- | ----------- |
  | `sign-in`         | IP       | 8 per 60 s  |
  | `sign-in-email`   | email    | 4 per 5 min |
  | `sign-up`         | IP       | 6 per 60 s  |
  | `sign-up-email`   | email    | 4 per 5 min |
  | `verify-web-code` | IP       | 8 per 60 s  |

- Requesting a code always reports success. A failed send is logged, never
  shown, so the response cannot reveal whether an address has an account.

## Sign-up and sign-in intent

- Sign-up asks for name and email; sign-in for email only.
- **Only the sign-up form creates a teacher.** An unknown email on the sign-in
  form gets "no account found" (`?error=no-account`), so a typo or a student's
  address never becomes a teacher account ([D-40](../decisions/D-40.md)).

## Where a person lands

`finalizeSignIn` (`app/actions/session.ts`) decides, in order:

1. An admin email (an `AdminUser` row, or the bootstrap allowlist) →
   `/admin`, or a safe `next`.
2. A teacher who has not finished onboarding → `/onboarding/reading`.
3. An onboarded teacher → a safe `next`, or `/dashboard`.
4. An email already linked to a student, or matching an unclaimed student row
   on some teacher's roster (linked now) → a safe `next`, or `/my-classes`.
5. A teacher email reached through a student path →
   `?error=teacher-email-conflict`. One identity is a teacher or a student,
   never both.
6. Neither, with sign-up intent → `/onboarding/reading`, where the teacher row
   is created.
7. Neither, with sign-in intent → "no account found", email pre-filled.

## Linking an identity to a roster student

- On first sign-in, an unclaimed student row with that email (case-insensitive)
  **that is on some teacher's roster** is linked to the identity
  (`lib/auth/student-link.ts`). If several match, the **oldest** wins. A row
  on no roster is never auto-linked.
- Once linked, every later sign-in resolves to that row. A race to link the
  same row resolves to one winner; the loser re-reads the linked row.
- The email-code and Google flows share this resolution.

## Google sign-in

- Shown only when Google credentials are configured (`hasGoogleAuthCreds`).
- Links automatically to an existing account with the same verified email;
  never merges accounts with different emails.
- A Google account resolves by Google's own account id, not by email.

## Changing the sign-in email

The flow itself is in [account settings](account-settings.md#sign-in-email-change).
What it does to sign-in (`lib/auth/identity-change.ts`):

- **Any linked Google account is disconnected** as part of every email change,
  whether or not the new address is a Google one. Otherwise the original Google
  account could sign in to the account forever, whatever email it now carries.
- **Every other session is signed out**; the device making the change stays
  signed in.
- The email code always works, so disconnecting Google never locks anyone out.
- Reconnecting Google is optional. It requires a Google sign-in whose email
  matches the **current** sign-in email exactly; a different Google account is
  rejected as a mismatch, and one already linked to another account as a
  duplicate. Cancelling Google's consent screen changes nothing.
- The notice to the old address says when Google was disconnected.
- The support path (an admin changing a student's email for her) does the same,
  and signs out **every** session, since the open one is the admin's.

## Sessions

- Cookie sessions in better-auth's `session` table. A route handler and a page
  resolve a session the same way, from the request headers.
- `src/middleware.ts` only checks that a session cookie is **present**; the
  page does the real check. A cookie whose session is gone (revoked, expired,
  account deleted) reaches the page as signed out — on the sign-in page too,
  which renders the form so the dead cookie can be replaced.
- Opening sign-in or sign-up while signed in sends the person on: to `next` if
  the link carried one, otherwise to their own landing.
- "Use a different account" on an invitation signs the session out first, then
  opens sign-in with the invited email and the invitation as `next`.
- There is no refresh token. A session ends when it expires or is revoked — by
  sign-out, an admin action, or account deletion.

## Links that sign a student in

Two student notifications carry a button that signs her in on the way
([D-40](../decisions/D-40.md), `lib/auth/notification-link.ts`). These are the
only paths that sign anyone in without a typed code: the server mints a
sign-in code and better-auth verifies it (`lib/auth/server-otp.ts`).

| Link            | Sent with                                  | Lands on                                                | Works for |
| --------------- | ------------------------------------------ | ------------------------------------------------------- | --------- |
| `/r/re/<token>` | a class canceled (by the teacher, or late) | the book page, with the canceled class's credits chosen | 72 hours  |
| `/r/ml/<token>` | her first paid checkout with a teacher     | her classes                                             | 1 hour    |

- The token is random, issued when the notification is sent, and stored only as
  a hash. It is bound to the student row, the email that row had, and the one
  class or notification it was sent for.
- **Each link works once.** Opening it shows a page with a single button; only
  pressing it uses the link. Email and chat link scanners open every link they
  see and must not be able to use one up.
- It stops working — with a "this link no longer works" page — once used,
  lapsed, opened on the wrong route, or no longer matching: the row's email
  changed, the class moved to another student, or the student left that
  teacher's roster. The rebook version links to her classes through ordinary
  sign-in.
- It never signs in a disabled student, a teacher or a staff member; they go to
  ordinary sign-in.
- The in-app inbox shows the same notices without a sign-in link, linking
  straight to the book page.

### Notification-settings link (does not sign in)

Every notification email carries `/r/notif-settings/<token>`, an HMAC-signed
token valid for 90 days (`lib/notifications/settings-link-token.ts`). It
proves who the recipient is, not who is at the keyboard, so it **never** signs
anyone in. If the device is already signed in as that recipient it goes
straight to their notification settings; otherwise to sign-in with their email
pre-filled and a "different account" notice.

## Roster invitations

- A teacher can email an invitation to a student she added
  (`lib/invitations/constants.ts`):
  - valid **30 days** (`INVITATION_TTL_DAYS`);
  - resendable once every **60 minutes** (`INVITATION_RESEND_COOLDOWN_MINUTES`);
  - up to **200** per bulk send (`INVITATION_BULK_MAX`);
  - the teacher is reminded once if it is unaccepted after **3 days**
    (`INVITATION_NUDGE_AFTER_DAYS`).
- Accepting requires being signed in with an email that **exactly matches**
  the invited one; anything else is rejected as a mismatch, so another session
  cannot accept someone's invitation. A teacher email is refused. Accepting
  twice is a no-op.
- Accepting links the student row as any sign-in does and clears that pairing's
  onboarding hold ([notifications](notifications.md#new-students-and-the-onboarding-hold)).
- Statuses (`InvitationStatus`): `pending`, `accepted`, `cancelled`; `expired`
  is reserved and not written — expiry is derived.
- A student who buys through a public booking page needs no invitation: the
  checkout email becomes her identity, and a sign-in code is sent after
  purchase (the result page can resend it).

## Redirect safety

`safeNextPath` (`lib/auth/safe-next.ts`) accepts a `next` only if it starts
with a single `/`, contains no control characters, and is not `//…` or `/\…`.
Anything else falls back to the default landing.

## Cross-origin protection

Cookie-authenticated mutating routes assert same-origin (`lib/auth/csrf.ts`):
`Sec-Fetch-Site` must not show another site, and `Origin`, when present, must
match the host. Signature-verified webhooks are exempt.

## Admin two-factor and step-up

- Every staff account must enrol an authenticator app (TOTP); there is no
  opt-out at any role.
- Enrolment alone is not enough: a compromised inbox would pass a check that
  only asked "is 2FA on?". The admin must also complete a TOTP **step-up** in
  the current session, valid **12 hours** (`ADMIN_STEPUP_TTL_MS`,
  `lib/auth/admin-stepup.ts`).
- Either missing → `/admin/security`, which (with the admin shell layout) only
  checks "is this an admin", to avoid a redirect loop.
- Roles, the bootstrap allowlist and page floors are in the
  [admin portal](admin-portal.md#identity-roles-and-capabilities).

## Error states

- "No account found" — sign-in with an email that is neither a teacher nor a
  linkable student.
- "Teacher email conflict" — a teacher's email reached through a student path.
- Too many requests — a rate limit; asked to wait, without revealing whether
  the email has an account.
- Invalid or expired code — must request a new one.
- Invitation errors — expired, cancelled, or a signed-in email that does not
  match.
- Admin sent to `/admin/security` — no TOTP, or no fresh step-up.

## Permissions

No one can choose or raise their own role: it follows from which record the
identity is linked to or created against. Teachers and students reach only
their own account; a sign-in identity is linked to at most one student row per
teacher.
