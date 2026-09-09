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
        className={cn("shrink-0 select-none rounded-full object-cover", box, className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full bg-primary/10 font-medium text-primary",
        box,
        text,
        className,
      )}
    >
      {initialsFrom(name, email)}
    </span>
  );
}
