import Link from "next/link";
import Image from "next/image";
import { initialsFrom } from "@/lib/initials";
import { cn } from "@/lib/utils";

// Someone's photo (or an initials monogram fallback) at whatever size a call
// site needs — the message thread header, a class-detail line, and the "My
// teachers" list all want the same look at different sizes.
//
// Role-neutral, because the teacher's side of the message thread needs exactly
// the same thing for a STUDENT and was hand-rolling a smaller, photo-less copy
// of it. `TeacherAvatar` stays as the name every existing call site imports.
export function PersonAvatar({
  name,
  photoUrl,
  size = 40,
  className,
}: {
  name: string;
  photoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  if (photoUrl) {
    return (
      <Image
        src={photoUrl}
        alt=""
        aria-hidden
        width={size}
        height={size}
        className={cn("shrink-0 select-none rounded-full object-cover", className)}
      />
    );
  }
  const textSizeClass = size >= 56 ? "text-xl" : size >= 40 ? "text-sm" : "text-xs";
  return (
    // A SOLID neutral fill, not `bg-primary/10 text-primary`. That tint is the
    // same defect the Badge variants were migrated off: a 10% wash composited
    // against whatever surface it lands on, then written on in `primary` — a
    // colour no token names, so the contrast test cannot assert it, and it
    // measured washed-out on the dark card this avatar sits on at 80px.
    //
    // Neutral rather than solid `primary`, because a monogram is not an
    // action. D-140 reserves the one saturated hue for the primary button and
    // for presence, and on the teacher profile this circle sits directly above
    // "Send a message" — two claims on the same colour, one of them idle.
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground",
        textSizeClass,
        className,
      )}
    >
      {initialsFrom(name, null)}
    </span>
  );
}

/** The teacher-facing name for {@link PersonAvatar}. */
export const TeacherAvatar = PersonAvatar;

// A teacher's name, linked to their student-facing profile — the one place a
// teacher's name should point whenever it appears in the student portal
// (upcoming classes, class detail, messages).
export function TeacherNameLink({
  teacherId,
  name,
  className,
}: {
  teacherId: string;
  name: string;
  className?: string;
}) {
  return (
    <Link href={`/my-classes/teachers/${teacherId}`} className={cn("hover:underline", className)}>
      {name}
    </Link>
  );
}
