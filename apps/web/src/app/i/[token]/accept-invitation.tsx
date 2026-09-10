"use client";

import { Heading } from "@/components/ui/heading";
import { useActionState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useT } from "@/components/locale-provider";
import { CORE_BENEFIT_KEYS, benefitCatalogKey } from "@/lib/invitations/benefits";
import { acceptInvitationAction, type AcceptActionState } from "@/app/actions/invitations";
import type { InvitationLandingInfo } from "@/lib/invitations/accept";

type Props = {
  token: string;
  state: InvitationLandingInfo["state"] | "invalid";
  teacherName: string;
  studentName: string | null;
  invitedEmail: string;
  teacherPhotoUrl: string | null;
  isAuthed: boolean;
  emailMatches: boolean;
};

export function AcceptInvitationView(props: Props) {
  const t = useT();
  const router = useRouter();
  const [actionState, formAction, pending] = useActionState<AcceptActionState, FormData>(
    acceptInvitationAction,
    undefined,
  );

  // On a successful accept, navigate to the student portal.
  useEffect(() => {
    if (actionState?.status === "accepted" && actionState.redirect) {
      router.replace(actionState.redirect);
    }
  }, [actionState, router]);

  const signInHref = `/sign-in?next=${encodeURIComponent(`/i/${props.token}`)}${
    props.invitedEmail ? `&email=${encodeURIComponent(props.invitedEmail)}` : ""
  }`;

  // Terminal / non-pending states get a simple status card.
  if (props.state === "invalid") {
    return (
      <Shell photo={null} name="">
        <StatusCard
          title={t("invitation.accept.invalidTitle")}
          body={t("invitation.accept.invalidBody")}
        />
      </Shell>
    );
  }
  if (props.state === "expired") {
    return (
      <Shell photo={props.teacherPhotoUrl} name={props.teacherName}>
        <StatusCard
          title={t("invitation.accept.expiredTitle")}
          body={t("invitation.accept.expiredBody", { teacher: props.teacherName })}
        />
      </Shell>
    );
  }
  if (props.state === "cancelled") {
    return (
      <Shell photo={props.teacherPhotoUrl} name={props.teacherName}>
        <StatusCard
          title={t("invitation.accept.cancelledTitle")}
          body={t("invitation.accept.cancelledBody", { teacher: props.teacherName })}
        />
      </Shell>
    );
  }
  if (props.state === "accepted") {
    return (
      <Shell photo={props.teacherPhotoUrl} name={props.teacherName}>
        <StatusCard
          title={t("invitation.accept.successTitle")}
          body={t("invitation.accept.successBody", { teacher: props.teacherName })}
          cta={{ href: "/my-classes", label: t("invitation.accept.goToClasses") }}
        />
      </Shell>
    );
  }

  // Handle a just-completed accept action's non-success outcomes inline.
  const actionError = renderActionError(actionState, props, t);

  return (
    <Shell photo={props.teacherPhotoUrl} name={props.teacherName}>
      <Card>
        <CardContent className="space-y-5 p-6">
          <div className="space-y-1 text-center">
            <Heading level={2} as="h1" className="font-serif">
              {t("invitation.accept.title")}
            </Heading>
            <p className="text-muted-foreground text-sm">
              {t("invitation.accept.invitedBy", { teacher: props.teacherName })}
            </p>
          </div>

          <p className="text-sm">{t("invitation.accept.intro", { teacher: props.teacherName })}</p>

          <div className="space-y-2">
            <p className="text-muted-foreground text-xs font-semibold">
              {t("invitation.accept.whatYouGet")}
            </p>
            <ul className="space-y-1.5">
              {CORE_BENEFIT_KEYS.map((key) => (
                <li key={key} className="flex items-start gap-2 text-sm">
                  <span aria-hidden className="text-primary mt-0.5">
                    ✓
                  </span>
                  <span>{t(benefitCatalogKey(key))}</span>
                </li>
              ))}
            </ul>
          </div>

          {actionError && (
            <p role="alert" className="text-destructive text-sm">
              {actionError}
            </p>
          )}

          {props.isAuthed && props.emailMatches ? (
            <form action={formAction}>
              <input type="hidden" name="token" value={props.token} />
              <Button
                type="submit"
                className="w-full"
                disabled={pending}
                data-testid="invitation-accept"
              >
                {pending ? t("invitation.accept.accepting") : t("invitation.accept.acceptCta")}
              </Button>
            </form>
          ) : props.isAuthed && !props.emailMatches ? (
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">
                {t("invitation.accept.mismatchBody", { email: props.invitedEmail })}
              </p>
              <Button asChild variant="outline" className="w-full">
                <Link href={signInHref}>{t("invitation.accept.switchAccount")}</Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-muted-foreground text-center text-sm">
                {t("invitation.accept.signInPrompt", { email: props.invitedEmail })}
              </p>
              <Button asChild className="w-full" data-testid="invitation-continue">
                <Link href={signInHref}>{t("invitation.accept.continueCta")}</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </Shell>
  );
}

function renderActionError(
  actionState: AcceptActionState,
  props: Props,
  t: ReturnType<typeof useT>,
): string | null {
  if (!actionState) return null;
  switch (actionState.status) {
    case "email_mismatch":
      return t("invitation.accept.mismatchBody", {
        email: actionState.invitedEmail ?? props.invitedEmail,
      });
    case "is_teacher":
      return t("invitation.accept.isTeacherBody");
    case "accepted_by_other":
      return t("invitation.accept.alreadyBody");
    case "expired":
      return t("invitation.accept.expiredBody", { teacher: props.teacherName });
    case "cancelled":
      return t("invitation.accept.cancelledBody", { teacher: props.teacherName });
    case "invalid":
      return t("invitation.accept.invalidBody");
    default:
      return null;
  }
}

function Shell({
  photo,
  name,
  children,
}: {
  photo: string | null;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-viewport bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        {photo && (
          <div className="flex justify-center">
            <Image
              src={photo}
              alt={name}
              width={72}
              height={72}
              className="border-border h-18 w-18 rounded-full border-2 object-cover"
              unoptimized
            />
          </div>
        )}
        {children}
      </div>
    </main>
  );
}

function StatusCard({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta?: { href: string; label: string };
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-6 text-center">
        <h1 className="font-serif text-xl font-semibold">{title}</h1>
        <p className="text-muted-foreground text-sm">{body}</p>
        {cta && (
          <Button asChild className="w-full">
            <Link href={cta.href}>{cta.label}</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
