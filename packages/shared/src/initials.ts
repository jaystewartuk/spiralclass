// Derives 1–2 uppercase initials for an avatar from a display name, falling
// back to the local-part of an email when no name is set (teacher rows seed
// `name` from the email local-part, so this stays sensible either way).
//
// Single token → its first letter; multiple tokens → first + last. Splits on
// any non-alphanumeric run so "maria.jose", "maria_jose" and "María José" all
// yield "MJ". Returns "?" when there's nothing to work with.
//
// Shared so web avatars and mobile avatars derive the SAME initials for a given
// person (mobile previously had a divergent whitespace-only implementation).
export function initialsFrom(name: string | null | undefined, email?: string | null): string {
  const source = name?.trim() || email?.split("@")[0] || "";
  const tokens = source.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length === 0) return "?";
  if (tokens.length === 1) return tokens[0]!.charAt(0).toUpperCase();
  return (tokens[0]!.charAt(0) + tokens[tokens.length - 1]!.charAt(0)).toUpperCase();
}
