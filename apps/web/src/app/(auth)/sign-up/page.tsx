import { SignUpForm } from "./sign-up-form";
import { hasGoogleAuthCreds } from "@/lib/env";
import { redirectIfSignedIn } from "@/app/(auth)/redirect-if-signed-in";

export default async function SignUpPage() {
  // Already signed in (a real session, not just a cookie) → the role landing.
  // See redirect-if-signed-in.ts for why the middleware must not make this call.
  await redirectIfSignedIn(null);
  return <SignUpForm googleEnabled={hasGoogleAuthCreds()} />;
}
