import { SignInForm } from "./sign-in-form";
import { hasGoogleAuthCreds } from "@/lib/env";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Empty by default so finalizeSignIn (app/actions/session.ts) picks the
  // right landing (teacher → /dashboard, student → /my-classes). A deep-link
  // redirect can still pass an explicit ?next=.
  const next = typeof params.next === "string" ? params.next : "";
  const error = typeof params.error === "string" ? params.error : null;
  const notice = typeof params.notice === "string" ? params.notice : null;
  const emailHint = typeof params.email === "string" ? params.email : "";
  return (
    <SignInForm
      next={next}
      error={error}
      notice={notice}
      emailHint={emailHint}
      googleEnabled={hasGoogleAuthCreds()}
    />
  );
}
