import { createT } from "./i18n/translate";
import type { LocaleCode as AppLocale } from "./api";
import {
  signUpSchemaWith,
  signInSchemaWith,
  phoneSignInSchemaWith,
  phoneCodeSchemaWith,
  timezoneSchemaWith,
  availabilityRangeSchemaWith,
  availabilitySchemaWith,
  blockedDateSchemaWith,
  checkoutIntentSchemaWith,
  leadCaptureSchemaWith,
  studentContactSchemaWith,
  teacherContactSchemaWith,
  teacherPublicWhatsappSchemaWith,
  materialStyleSchemaWith,
  teacherEditStudentContactSchemaWith,
  teacherCreateStudentSchemaWith,
  wiseInstrumentSchemaWith,
  paymentSelectionSchemaWith,
  transferConfirmSchemaWith,
  singleInviteSchemaWith,
  bulkInviteSchemaWith,
} from "./validators-core";

export * from "./validators-core";

// Each form schema by locale, for the server: `signInSchema(locale)`. The
// schemas themselves are in ./validators-core and take a `t`, because that
// module is the one a browser loads — and this one, which reaches every
// language through createT, must not be. A Client Component calls
// `signInSchemaWith(useT())`.
export const signUpSchema = (locale: AppLocale = "en") => signUpSchemaWith(createT(locale));
export const signInSchema = (locale: AppLocale = "en") => signInSchemaWith(createT(locale));
export const phoneSignInSchema = (locale: AppLocale = "en") =>
  phoneSignInSchemaWith(createT(locale));
export const phoneCodeSchema = (locale: AppLocale = "en") => phoneCodeSchemaWith(createT(locale));
export const timezoneSchema = (locale: AppLocale = "en") => timezoneSchemaWith(createT(locale));
export const availabilityRangeSchema = (locale: AppLocale = "en") =>
  availabilityRangeSchemaWith(createT(locale));
export const availabilitySchema = (locale: AppLocale = "en") =>
  availabilitySchemaWith(createT(locale));
export const blockedDateSchema = (locale: AppLocale = "en") =>
  blockedDateSchemaWith(createT(locale));
export const checkoutIntentSchema = (locale: AppLocale = "en") =>
  checkoutIntentSchemaWith(createT(locale));
export const leadCaptureSchema = (locale: AppLocale = "en") =>
  leadCaptureSchemaWith(createT(locale));
export const studentContactSchema = (locale: AppLocale = "en") =>
  studentContactSchemaWith(createT(locale));
export const teacherContactSchema = (locale: AppLocale = "en") =>
  teacherContactSchemaWith(createT(locale));
export const teacherPublicWhatsappSchema = (locale: AppLocale = "en") =>
  teacherPublicWhatsappSchemaWith(createT(locale));
export const materialStyleSchema = (locale: AppLocale = "en") =>
  materialStyleSchemaWith(createT(locale));
export const teacherEditStudentContactSchema = (locale: AppLocale = "en") =>
  teacherEditStudentContactSchemaWith(createT(locale));
export const teacherCreateStudentSchema = (locale: AppLocale = "en") =>
  teacherCreateStudentSchemaWith(createT(locale));
export const wiseInstrumentSchema = (locale: AppLocale = "en") =>
  wiseInstrumentSchemaWith(createT(locale));
export const paymentSelectionSchema = (locale: AppLocale = "en") =>
  paymentSelectionSchemaWith(createT(locale));
export const transferConfirmSchema = (locale: AppLocale = "en") =>
  transferConfirmSchemaWith(createT(locale));
export const singleInviteSchema = (locale: AppLocale = "en") =>
  singleInviteSchemaWith(createT(locale));
export const bulkInviteSchema = (locale: AppLocale = "en") => bulkInviteSchemaWith(createT(locale));
