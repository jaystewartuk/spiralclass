import type { LocaleCode } from "./api";
import { countryLabel } from "./countries";

// Canonical E.164 normalization, shared by web and mobile so a WhatsApp number
// is stored/displayed identically no matter which client submitted it.
//
// Teachers and students are anywhere in the world, so the ONLY reliable input
// is the caller's `countryHint` (an ISO-3166-1 alpha-2 code — a teacher's own
// `country`, or a country the person explicitly picked next to the phone
// field). Pass one at every call site; the numbering plan of the hinted
// country is what decides how a bare national number is read.
//
// The validators accept a bare, country-code-less number (`^\+?\d{8,15}$`),
// because that is how a local number is written everywhere — "07700 900123",
// "01 42 86 80 00", "55 1234 5678". Two things have to happen to turn one of
// those into E.164, and both are country-specific:
//
//   1. **Drop the trunk prefix.** Most of the world writes its national number
//      with a leading "0" that E.164 does not carry. Italy (and the two states
//      inside its numbering plan) is the well-known exception — a Roman
//      landline really is "+39 06…" — so it is excluded. Mexico's legacy
//      "044"/"045"/"01" mobile prefixes are their own case, and are stripped
//      ONLY for MX: the same pattern applied to a French "01 42 86 80 00" ate
//      its area code and minted a number for a stranger.
//   2. **Prepend the right calling code.** Blindly prepending "+" minted a
//      wrong-country E.164 ("5512345678" → "+55…", a Brazilian number), so
//      WhatsApp reminders and phone-OTP codes went to a stranger.
//
// With NO usable hint there is nothing to read the number against, and the
// historical Mexico-first heuristic is kept as the last resort (a bare
// 10-digit number defaults to +52) purely so pre-existing MX rows and call
// sites are unaffected. It is a fallback, not a statement about who uses the
// product — fix the call site rather than relying on it.
//
// An input that already carries a "+" is trusted as-is (the sender gave a
// country code); "00"/"011" international prefixes are converted to "+"; and
// a number that already leads with the resolved country's calling code is
// left alone.
const MX_CC = "52";

// The numbering plan read against when the caller gives no usable hint. See
// the header — a last resort, not a default audience.
const FALLBACK_PHONE_COUNTRY = "MX";

// Countries whose national numbers KEEP their leading zero in E.164. Italy is
// the standard exception to the trunk-prefix rule, and San Marino and Vatican
// City sit inside its numbering plan.
const TRUNK_ZERO_IS_SIGNIFICANT = new Set(["IT", "SM", "VA"]);

// ITU-T E.164 calling codes for every ISO-3166-1 alpha-2 code in
// COUNTRY_CODES (countries.ts) — this is public assigned-number-plan data,
// not a guess. A handful of uninhabited/dependent territories with no
// independent plan (Bouvet Island, the French Southern Territories, Cocos
// and Christmas Islands, Heard Island) are mapped to the parent/administering
// country's code so a lookup never throws; nobody realistically enters a
// phone number from these. NANP members (US, CA, and most Caribbean
// islands/territories) share "1" — the shared code is enough for
// normalization even though their area codes differ.
const COUNTRY_CALLING_CODES: Record<string, string> = {
  AD: "376",
  AE: "971",
  AF: "93",
  AG: "1",
  AI: "1",
  AL: "355",
  AM: "374",
  AO: "244",
  AQ: "672",
  AR: "54",
  AS: "1",
  AT: "43",
  AU: "61",
  AW: "297",
  AX: "358",
  AZ: "994",
  BA: "387",
  BB: "1",
  BD: "880",
  BE: "32",
  BF: "226",
  BG: "359",
  BH: "973",
  BI: "257",
  BJ: "229",
  BL: "590",
  BM: "1",
  BN: "673",
  BO: "591",
  BQ: "599",
  BR: "55",
  BS: "1",
  BT: "975",
  BV: "47",
  BW: "267",
  BY: "375",
  BZ: "501",
  CA: "1",
  CC: "61",
  CD: "243",
  CF: "236",
  CG: "242",
  CH: "41",
  CI: "225",
  CK: "682",
  CL: "56",
  CM: "237",
  CN: "86",
  CO: "57",
  CR: "506",
  CU: "53",
  CV: "238",
  CW: "599",
  CX: "61",
  CY: "357",
  CZ: "420",
  DE: "49",
  DJ: "253",
  DK: "45",
  DM: "1",
  DO: "1",
  DZ: "213",
  EC: "593",
  EE: "372",
  EG: "20",
  EH: "212",
  ER: "291",
  ES: "34",
  ET: "251",
  FI: "358",
  FJ: "679",
  FK: "500",
  FM: "691",
  FO: "298",
  FR: "33",
  GA: "241",
  GB: "44",
  GD: "1",
  GE: "995",
  GF: "594",
  GG: "44",
  GH: "233",
  GI: "350",
  GL: "299",
  GM: "220",
  GN: "224",
  GP: "590",
  GQ: "240",
  GR: "30",
  GS: "500",
  GT: "502",
  GU: "1",
  GW: "245",
  GY: "592",
  HK: "852",
  HM: "61",
  HN: "504",
  HR: "385",
  HT: "509",
  HU: "36",
  ID: "62",
  IE: "353",
  IL: "972",
  IM: "44",
  IN: "91",
  IO: "246",
  IQ: "964",
  IR: "98",
  IS: "354",
  IT: "39",
  JE: "44",
  JM: "1",
  JO: "962",
  JP: "81",
  KE: "254",
  KG: "996",
  KH: "855",
  KI: "686",
  KM: "269",
  KN: "1",
  KP: "850",
  KR: "82",
  KW: "965",
  KY: "1",
  KZ: "7",
  LA: "856",
  LB: "961",
  LC: "1",
  LI: "423",
  LK: "94",
  LR: "231",
  LS: "266",
  LT: "370",
  LU: "352",
  LV: "371",
  LY: "218",
  MA: "212",
  MC: "377",
  MD: "373",
  ME: "382",
  MF: "590",
  MG: "261",
  MH: "692",
  MK: "389",
  ML: "223",
  MM: "95",
  MN: "976",
  MO: "853",
  MP: "1",
  MQ: "596",
  MR: "222",
  MS: "1",
  MT: "356",
  MU: "230",
  MV: "960",
  MW: "265",
  MX: "52",
  MY: "60",
  MZ: "258",
  NA: "264",
  NC: "687",
  NE: "227",
  NF: "672",
  NG: "234",
  NI: "505",
  NL: "31",
  NO: "47",
  NP: "977",
  NR: "674",
  NU: "683",
  NZ: "64",
  OM: "968",
  PA: "507",
  PE: "51",
  PF: "689",
  PG: "675",
  PH: "63",
  PK: "92",
  PL: "48",
  PM: "508",
  PN: "64",
  PR: "1",
  PS: "970",
  PT: "351",
  PW: "680",
  PY: "595",
  QA: "974",
  RE: "262",
  RO: "40",
  RS: "381",
  RU: "7",
  RW: "250",
  SA: "966",
  SB: "677",
  SC: "248",
  SD: "249",
  SE: "46",
  SG: "65",
  SH: "290",
  SI: "386",
  SJ: "47",
  SK: "421",
  SL: "232",
  SM: "378",
  SN: "221",
  SO: "252",
  SR: "597",
  SS: "211",
  ST: "239",
  SV: "503",
  SX: "1",
  SY: "963",
  SZ: "268",
  TC: "1",
  TD: "235",
  TF: "262",
  TG: "228",
  TH: "66",
  TJ: "992",
  TK: "690",
  TL: "670",
  TM: "993",
  TN: "216",
  TO: "676",
  TR: "90",
  TT: "1",
  TV: "688",
  TW: "886",
  TZ: "255",
  UA: "380",
  UG: "256",
  UM: "1",
  US: "1",
  UY: "598",
  UZ: "998",
  VA: "379",
  VC: "1",
  VE: "58",
  VG: "1",
  VI: "1",
  VN: "84",
  VU: "678",
  WF: "681",
  WS: "685",
  YE: "967",
  YT: "262",
  ZA: "27",
  ZM: "260",
  ZW: "263",
};

/**
 * Normalize a phone number to E.164. `countryHint` (ISO-3166-1 alpha-2, e.g.
 * "US") is used to resolve a bare national-format number (no "+", no
 * recognizable country code) to the right calling code — pass a teacher's
 * `country`, or a country the person explicitly picked next to the phone
 * field. When the hint maps to a known calling code, it's trusted directly
 * (not every country's national number is 10 digits, unlike Mexico's).
 * Omit it (or pass an unmapped country) to keep the historical MX-default
 * 10-digit heuristic.
 */
export function normalizeE164(input: string, countryHint?: string): string {
  // Strip everything users paste as separators, plus parens/dots.
  let s = input.replace(/[\s().-]/g, "");
  if (s.startsWith("+")) return s;
  // International access prefixes → "+".
  if (s.startsWith("00")) return `+${s.slice(2)}`;
  if (s.startsWith("011")) return `+${s.slice(3)}`;

  const hint = countryHint?.toUpperCase();
  const hinted = Boolean(hint && COUNTRY_CALLING_CODES[hint]);
  // The numbering plan `s` is read against: the caller's hint when it maps to
  // a real calling code, else the documented last-resort fallback.
  const country = hinted ? hint! : FALLBACK_PHONE_COUNTRY;
  const cc = COUNTRY_CALLING_CODES[country] ?? MX_CC;

  if (country === "MX") {
    // Legacy MX trunk / mobile prefixes dialed before the 10-digit national
    // number ("044 55…", "045 55…", "01 55…"). Scoped to MX deliberately: the
    // same pattern applied to a French "01 42 86 80 00" ate its area code and
    // produced a working number belonging to someone else.
    s = s.replace(/^0(44|45|1)/, "");
  } else if (!TRUNK_ZERO_IS_SIGNIFICANT.has(country)) {
    // The trunk prefix most of the world writes and E.164 does not carry:
    // "07700 900123" → "+447700900123", "0142868000" → "+33142868000". A
    // country with no trunk prefix (the NANP, MX, ES, PT…) never presents a
    // leading 0, so this is a no-op there rather than a special case.
    s = s.replace(/^0/, "");
  }

  // Already carries the resolved country's calling code (cc + 10 national
  // digits) — most common for the MX fallback; other countries' national
  // numbers vary in length, so this check is a shortcut, not a requirement.
  if (s.startsWith(cc) && s.length === cc.length + 10) return `+${s}`;
  if (hinted) {
    // An explicit, user-declared country: trust it over the MX-specific
    // 10-digit heuristic below.
    return `+${cc}${s}`;
  }
  // No usable hint — fall back to the historical MX heuristic: a plain
  // 10-digit national number defaults to +52. See the module header.
  if (s.length === 10) return `+${MX_CC}${s}`;
  // Anything else already includes a country code (e.g. a US "1…" number, or
  // another international number typed without the "+"): prepend "+" as before.
  return `+${s}`;
}

/**
 * Inverse of `normalizeE164`: split a stored E.164 number back into the
 * `{ country, localNumber }` a phone field's two controls need — the
 * dial-code dropdown and the bare national-number text input. Without this,
 * re-populating an edit form from a saved `phoneE164` (e.g. "+521234567890")
 * dumped the whole string, "+" and country code included, into the
 * national-number field, duplicating the code already shown in the dropdown.
 *
 * `countryHint` (e.g. the acting teacher's own country) is tried first and
 * wins if its calling code actually matches the number's prefix; otherwise
 * the longest matching calling code in `COUNTRY_CALLING_CODES` is used, since
 * some codes are prefixes of others (e.g. "1" vs "18..."-style NANP codes
 * would never collide, but shorter/longer codes elsewhere can). A calling
 * code shared by multiple countries (NANP's "1", GB/IM/JE/GG's "44", RU/KZ's
 * "7") resolves to whichever of those the lookup table happens to match
 * first — good enough for defaulting a dropdown, not a claim of certainty.
 */
export function splitE164(
  e164: string,
  countryHint?: string,
): { country: string; localNumber: string } {
  const s = e164.startsWith("+") ? e164.slice(1) : e164;
  const hint = countryHint?.toUpperCase();
  const hintCode = hint ? COUNTRY_CALLING_CODES[hint] : undefined;
  if (hint && hintCode && s.startsWith(hintCode)) {
    return { country: hint, localNumber: s.slice(hintCode.length) };
  }
  let bestCountry = "";
  let bestCode = "";
  for (const [code, dialCode] of Object.entries(COUNTRY_CALLING_CODES)) {
    if (s.startsWith(dialCode) && dialCode.length > bestCode.length) {
      bestCountry = code;
      bestCode = dialCode;
    }
  }
  if (bestCode) {
    return { country: bestCountry, localNumber: s.slice(bestCode.length) };
  }
  return { country: hint ?? FALLBACK_PHONE_COUNTRY, localNumber: s };
}

/**
 * Options for a phone-number country picker: every ISO code in
 * `COUNTRY_CALLING_CODES`, localized and sorted by label, each carrying its
 * dial code for display (e.g. "+52"). The selected `code` is what callers
 * pass back into `normalizeE164` as `countryHint`.
 */
export function phoneCountryOptions(
  locale: LocaleCode = "en",
): Array<{ code: string; dialCode: string; label: string }> {
  const collator = new Intl.Collator(locale);
  return Object.entries(COUNTRY_CALLING_CODES)
    .map(([code, dialCode]) => ({ code, dialCode, label: countryLabel(code, locale) }))
    .sort((a, b) => collator.compare(a.label, b.label));
}

/**
 * Builds a `wa.me` deep-link that opens a chat with `e164` pre-filled with
 * `message` — the plain, no-Meta-integration WhatsApp link D-42 kept (see
 * `docs/decisions/D-42.md`) after the automated Cloud API send rail was
 * removed. Shared by web (booking-page "Chat on WhatsApp" button) and mobile
 * (same button, opened via `Linking.openURL`) so both build the exact same
 * URL from the exact same stored number. `wa.me` wants bare digits — no `+`,
 * no separators — so this strips everything but `[0-9]` regardless of how
 * `e164` is formatted. Returns null for an empty/unparseable number so
 * callers can hide the button rather than link to a broken chat.
 */
export function whatsAppChatUrl(e164: string, message?: string): string | null {
  const digits = e164.replace(/\D/g, "");
  if (!digits) return null;
  const query = message ? `?text=${encodeURIComponent(message)}` : "";
  return `https://wa.me/${digits}${query}`;
}
