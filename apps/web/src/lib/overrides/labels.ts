import type { TFunction } from "@/lib/i18n-translate";

/**
 * The human name for a row in the override log.
 *
 * `Override.action` is a bare string column, and two screens read it: the
 * class-detail page, which had this table inline, and the teacher's
 * student-detail page, which had no table at all and printed the raw value —
 * a teacher's "Account adjustments" card literally said `set_custom_price`
 * and `archive_student`. Shared here so the two agree, and so adding an
 * action to `app/actions/overrides.ts` has one obvious place to name it.
 *
 * The fallback is the raw action rather than a throw: the log is history, and
 * an action retired from the codebase still has rows pointing at it.
 */
export function overrideActionLabel(action: string, t: TFunction): string {
  const map: Record<string, string> = {
    teacher_book_class: t("web.dashboard.classes.detail.overrideLog.teacherBookClass"),
    teacher_cancel: t("web.dashboard.classes.detail.overrideLog.teacherCancel"),
    mark_complete: t("web.dashboard.classes.detail.overrideLog.markComplete"),
    mark_no_show: t("web.dashboard.classes.detail.overrideLog.markNoShow"),
    restore_class: t("web.dashboard.classes.detail.overrideLog.restoreClass"),
    waive_cancellation: t("web.dashboard.classes.detail.overrideLog.waiveCancellation"),
    extend_expiration: t("web.dashboard.classes.detail.overrideLog.extendExpiration"),
    set_custom_price: t("web.dashboard.classes.detail.overrideLog.setCustomPrice"),
    // Student-scoped, and the reason this module exists: these two only ever
    // appear on the student page, which is the one that had no table.
    archive_student: t("web.dashboard.classes.detail.overrideLog.archiveStudent"),
    reactivate_student: t("web.dashboard.classes.detail.overrideLog.reactivateStudent"),
    set_class_language: t("web.dashboard.classes.detail.overrideLog.setClassLanguage"),
  };
  return map[action] ?? action;
}
