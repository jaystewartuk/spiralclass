"use client";

import Image from "next/image";
import { initialsFrom } from "@/lib/initials";
import { cn } from "@/lib/utils";

// The signed-in account's avatar: the uploaded profile photo when there is one,
// otherwise the initials monogram. One component so every authenticated header
// (desktop menu trigger, dropdown badge, mobile panel) shows the same thing and
// the photo/initials fallback logic lives in a single place.
//
//   size="sm"  header chrome / menu trigger (28px)
//   size="lg"  stacked badge in menus & mobile panels (36px)
//   size="xl"  the identity block at the top of an account page (80px) — the
//              one place the avatar is the subject rather than a label on one
//
// `photoUrl` is already version-stamped by the caller (teacherPhotoPublicUrl),
// so a re-upload busts the CDN copy. Absent for students/admins/onboarding —
// they simply fall through to the monogram.

// One row per size: the intrinsic pixel size Next/Image renders the photo at,
// the box both branches share, and the monogram's step off the type scale.
const SIZES = {
  sm: { px: 28, box: "h-7 w-7", text: "text-xs" },
  lg: { px: 36, box: "h-9 w-9", text: "text-sm" },
  xl: { px: 80, box: "h-20 w-20", text: "text-xl" },
} as const;

export function AccountAvatar({
  name,
  email,
  photoUrl,
  size = "sm",
  className,
}: {
  name?: string | null;
  email?: string | null;
  photoUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const { px, box, text } = SIZES[size];

  if (photoUrl) {
    return (
      <Image
        src={photoUrl}
        alt=""
        aria-hidden
        width={px}
        height={px}
        className={cn("shrink-0 rounded-full object-cover select-none", box, className)}
      />
    );
  }

  return (
    // A SOLID neutral fill, for the reason written out in full at
    // components/teacher-identity.tsx and components/ui/badge.tsx: a 10% wash
    // composited against whatever surface it lands on, written on in `primary`,
    // is a colour no token names and palette-contrast.test.ts cannot assert.
    // This was the last monogram still painting one — the `xl` size renders it
    // at 80px on the account page's raised card, which is the darkest ground
    // the same pairing measured 4.24:1 against on /about.
    <span
      aria-hidden
      className={cn(
        "bg-secondary text-secondary-foreground inline-flex shrink-0 items-center justify-center rounded-full font-medium select-none",
        box,
        text,
        className,
      )}
    >
      {initialsFrom(name, email)}
    </span>
  );
}
