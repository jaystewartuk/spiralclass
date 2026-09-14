import { randomInt } from "node:crypto";

/** 10 lowercase base32-ish chars: ~50 bits, unguessable, still typeable. */
export const TRACKING_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const TRACKING_CODE_LENGTH = 10;

// `randomInt` rather than `randomBytes(n)[i] % alphabet.length`. The modulo was
// only unbiased because the alphabet happens to be 32 characters, a divisor of
// 256; one more or one fewer character would silently make some codes likelier
// than others. `randomInt` is uniform for any alphabet length.
export function newTrackingCode(): string {
  let out = "";
  for (let i = 0; i < TRACKING_CODE_LENGTH; i++) {
    out += TRACKING_ALPHABET[randomInt(TRACKING_ALPHABET.length)];
  }
  return out;
}
