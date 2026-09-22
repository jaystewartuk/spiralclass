// Client-side "validate on submit" helpers, shared by web and mobile so a
// form's required-field rules live in exactly one place instead of being
// hand-rolled per screen. Pair with a per-app field-errors hook: keep the
// submit button always enabled (except while in flight), call the validator
// on submit, and render the returned messages next to each field instead of
// disabling the button until everything happens to already be valid.
//
// Validators return error CODES, not localized strings — web and mobile each
// have their own i18n mechanism (inline es/en ternaries vs. a t() key table),
// so each app maps a code to its own copy rather than duplicating translated
// text in this package.

export function hasFieldErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some(Boolean);
}

// Flatten a Zod error to the FIRST message per top-level field, shaped for a
// useFieldErrors map. Lets a client form run one of the shared `validators.ts`
// schemas on submit and render each issue next to its field, instead of only
// surfacing the server action's single form-level string. Nested paths collapse
// to their first segment (e.g. `ranges.0.endTime` → `ranges`); forms that need
// per-row errors read `error.issues` directly. Typed against a structural
// subset of ZodError so this stays a `import type` and never pulls zod into a
// bundle that doesn't already have it.
type ZodIssueLike = { path: PropertyKey[]; message: string };
export function zodFieldErrors(error: { issues: ZodIssueLike[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (key == null) continue;
    const k = String(key);
    if (!(k in out)) out[k] = issue.message;
  }
  return out;
}

export type ManualPackageFieldErrorCode =
  "required" | "invalid-number" | "remaining-gt-total" | "remaining-gt-max";

export type ManualPackageFieldErrors = {
  classesTotal?: ManualPackageFieldErrorCode;
  classesRemaining?: ManualPackageFieldErrorCode;
};

// The "record an off-platform package" form (add + edit) on both apps: the
// teacher types the total and how many classes are LEFT. `maxRemaining`, when
// given, is the edit form's extra ceiling (total minus classes already
// booked/taken against the package).
export function validateManualPackageFields(input: {
  classesTotal: string;
  classesRemaining: string;
  maxRemaining?: number;
}): ManualPackageFieldErrors {
  const errors: ManualPackageFieldErrors = {};
  const total = Number(input.classesTotal);
  const remaining = Number(input.classesRemaining);

  if (input.classesTotal.trim() === "") {
    errors.classesTotal = "required";
  } else if (!Number.isFinite(total) || total <= 0) {
    errors.classesTotal = "invalid-number";
  }

  if (input.classesRemaining.trim() === "") {
    errors.classesRemaining = "required";
  } else if (!Number.isFinite(remaining) || remaining < 0) {
    errors.classesRemaining = "invalid-number";
  } else if (!errors.classesTotal) {
    if (remaining > total) {
      errors.classesRemaining = "remaining-gt-total";
    } else if (input.maxRemaining != null && remaining > input.maxRemaining) {
      errors.classesRemaining = "remaining-gt-max";
    }
  }

  return errors;
}

// The unified "add material" form (web `material-form.tsx` + mobile
// `AddMaterialModal`). A material is one row that can carry any combination of
// a written body, an uploaded file, and a link — so the only hard rules are:
// a level must be chosen (library scope), at least one of the three pieces is
// present, and a link, if typed, is a real URL. These mirror the server rules
// in `saveMaterialContentAction` (levelId + "Add content, a file, or a link."
// + `materialLinkSchema`), kept here so the client can point at the offending
// field on submit instead of silently disabling the button. `content` is a
// synthetic field name the two forms render near the body/file/link cluster.
export type MaterialFieldErrorCode = "required" | "invalid-url";

export type MaterialFieldErrors = {
  level?: MaterialFieldErrorCode;
  content?: MaterialFieldErrorCode;
  linkUrl?: MaterialFieldErrorCode;
};

function isParseableUrl(value: string): boolean {
  try {
    // Matches the server's `z.string().url()`, which parses with the URL
    // constructor — any scheme the platform later stores is accepted here.
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function validateMaterialFields(input: {
  levelId: string;
  hasBody: boolean;
  hasFile: boolean;
  linkUrl: string;
  // Booking-scope materials attach to one class and carry no level of their
  // own, so the level rule only applies in library scope (the default).
  requireLevel?: boolean;
}): MaterialFieldErrors {
  const errors: MaterialFieldErrors = {};
  if ((input.requireLevel ?? true) && input.levelId.trim() === "") {
    errors.level = "required";
  }
  const link = input.linkUrl.trim();
  if (!input.hasBody && !input.hasFile && link === "") {
    errors.content = "required";
  }
  if (link !== "" && !isParseableUrl(link)) {
    errors.linkUrl = "invalid-url";
  }
  return errors;
}

// One draft-vs-saved comparator for the unified material form, shared by web
// (`use-unsaved-changes-guard.ts`) and mobile (`MaterialForm.tsx`) so the two
// platforms can't disagree about what counts as an unsaved edit. Optional
// fields exist because booking scope has no label/level/visibility/tags of its
// own — a context that never renders a field simply omits it from BOTH
// snapshots. `undefined` and `""` compare equal so a context that seeds a
// field with an empty string stays clean against one that omitted it.
export type MaterialDraftSnapshot = {
  body: string;
  source: string;
  label?: string;
  levelId?: string;
  visibility?: string;
  focusTagIds?: readonly string[];
  linkUrl?: string;
};

function scalarDiffers(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") !== (b ?? "");
}

export function isMaterialDraftDirty(
  current: MaterialDraftSnapshot,
  lastSaved: MaterialDraftSnapshot,
): boolean {
  if (
    scalarDiffers(current.body, lastSaved.body) ||
    scalarDiffers(current.source, lastSaved.source) ||
    scalarDiffers(current.label, lastSaved.label) ||
    scalarDiffers(current.levelId, lastSaved.levelId) ||
    scalarDiffers(current.visibility, lastSaved.visibility) ||
    scalarDiffers(current.linkUrl, lastSaved.linkUrl)
  ) {
    return true;
  }
  // Tag SELECTION is what saves — order is a UI artifact (web holds a Set,
  // mobile iterates groups), so reordering alone must not read as dirty.
  const a = new Set(current.focusTagIds ?? []);
  const b = new Set(lastSaved.focusTagIds ?? []);
  if (a.size !== b.size) return true;
  for (const id of a) if (!b.has(id)) return true;
  return false;
}

// The one line of save-state copy the pinned action bar shows. Precedence is
// the point: `dirty` beats `savedOk`, so the moment a teacher edits again the
// stale "Saved" clears with no extra state or effect.
export type MaterialSaveStatus = "idle" | "dirty" | "saving" | "saved";

export function materialSaveStatus(input: {
  saving: boolean;
  dirty: boolean;
  savedOk: boolean;
}): MaterialSaveStatus {
  if (input.saving) return "saving";
  if (input.dirty) return "dirty";
  if (input.savedOk) return "saved";
  return "idle";
}

// Codes → localized copy for the material form. Lives here (not per-app like
// `packageFieldMessage`) because web and mobile now draw from ONE i18n catalog,
// so the wording can't drift. Each app passes its own `t`; the key union keeps
// this decoupled from the full StringKey type while staying assignable from
// either app's `t`.
type MaterialMessageKey =
  "libManage.chooseLevel" | "libManage.needAttachment" | "libManage.linkInvalid";

export function materialFieldMessages(
  errors: MaterialFieldErrors,
  t: (key: MaterialMessageKey) => string,
): { level?: string; content?: string; linkUrl?: string } {
  return {
    level: errors.level ? t("libManage.chooseLevel") : undefined,
    content: errors.content ? t("libManage.needAttachment") : undefined,
    linkUrl: errors.linkUrl ? t("libManage.linkInvalid") : undefined,
  };
}
