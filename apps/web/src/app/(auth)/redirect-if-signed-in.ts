import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { finalizeSignIn } from "@/app/actions/session";

// /sign-in and /sign-up send a visitor who already holds a VALID session on
// their way, exactly where a fresh sign-in would have landed them: the safe
// `?next=` when there is one, else the role landing (teacher → /dashboard,
// student → /my-classes, staff → /admin). finalizeSignIn owns that resolution
// so the two paths can never disagree.
//
// This decision belongs here, on auth.api.getSession() (via getAuthUser), and
// NOT in the middleware on cookie presence: a cookie that has outlived its
// session — revoked, expired, or the user deleted server-side — used to bounce
// /sign-in → /dashboard, where the missing session bounced straight back, until
// the browser gave up on a blank page. With no session there is nothing to do
// and the form renders; the sign-in that follows replaces the dead cookie.
//
// Returns without redirecting when the landing is itself a sign-in page — an
// identity with neither a Teacher nor a Student row (D-56's "no account"), or
// a teacher-email conflict. Redirecting there would be this page redirecting
// to itself forever; rendering the form instead lets the person sign in with
// the address that does have an account.
export async function redirectIfSignedIn(next: string | null): Promise<void> {
  const user = await getAuthUser();
  if (!user) return;
  const destination = await finalizeSignIn(next, { id: user.id, email: user.email }, "sign-in");
  if (destination.startsWith("/sign-in")) return;
  redirect(destination);
}
