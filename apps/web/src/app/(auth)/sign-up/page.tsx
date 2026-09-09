import { SignUpForm } from "./sign-up-form";
import { hasGoogleAuthCreds } from "@/lib/env";

export default function SignUpPage() {
  return <SignUpForm googleEnabled={hasGoogleAuthCreds()} />;
}
