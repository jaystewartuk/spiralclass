// Shared helpers for the E2E specs. All imports are `@prisma/client` directly
// — never `@/lib/*` — because Playwright's CJS test loader can't load the
// app's ESM lib wrappers (see prisma.ts).
//
// The bearer-session and JSON-header helpers went with the three API specs
// that drove them. The browser journeys sign in with `signInAsViaOtp`.
export { REQUIRED_ENV, missingEnv, applyE2ESkipGuards } from "./env";
export { getPrisma } from "./prisma";
export { signInAsViaOtp } from "./better-auth";
export { nextWeekdayISO } from "./dates";
export { blockCheckoutStub, clickLinkUntilNavigated } from "./web";
export {
  TEACHER_EMAIL,
  TEACHER_BOOKING_SLUG,
  purchaseAndActivatePackage,
  bookAClass,
  deleteStudentsByEmail,
  notificationsForBooking,
  expectBothSidesNotified,
  type PurchasedPackage,
  type PurchaseOptions,
  type BookOptions,
} from "./fixtures";
