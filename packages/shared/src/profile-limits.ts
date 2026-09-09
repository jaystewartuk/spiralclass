// Teacher booking-page profile field limits — the single source of truth for
// both apps. Previously hardcoded independently in three places (web's
// saveHeadlineAction/saveBioAction, the mobile REST route's Zod schema, and
// mobile's BookingPageCard), which let them drift silently.
export const HEADLINE_MAX_LENGTH = 80;
export const BIO_MAX_LENGTH = 280;
