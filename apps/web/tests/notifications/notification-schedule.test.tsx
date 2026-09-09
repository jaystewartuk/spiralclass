import { describe, expect, it, vi } from "vitest";
import {
  TEMPLATE_NAMES,
  isRetiredTemplate,
  isTeacherRecipientTemplate,
  type TemplateName,
} from "@/lib/notifications/templates";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALWAYS,
  NotificationSchedule,
  STUDENT_ROWS,
  TEACHER_ROWS,
} from "@/components/notification-schedule";
import { templateCategory, teacherTemplateCategory } from "@/lib/notifications/preferences";
import { CATEGORY_HINT_KEYS, CATEGORY_LABEL_KEYS } from "@/lib/notifications/category-labels";
import { LOCALES, createT } from "@spiralclass/shared";

// The schedule resolves its copy through getT(), which outside a request scope
// falls back to whatever the suite's locale setup leaves in place. Pin it, so
// the render assertions below name the strings they are actually checking.
vi.mock("@/lib/i18n", () => ({ getT: async () => createT("en") }));

// The schedule is a Server Component compiled with the classic JSX runtime in
// this project's test config; awaiting it and rendering the element it returns
// needs React on the global.
(globalThis as Record<string, unknown>).React = React;

// Guards notification-schedule.tsx (the "what we send and when" reference
// shown on the settings pages) against silently going stale. Rows declare
// exactly which template names they cover; this asserts every template in
// TEMPLATE_NAMES — the dispatcher's own source of truth — appears in one row
// for the right audience. A new/removed producer without a matching row edit
// fails here instead of drifting unnoticed, the way the class_reminders 5m
// leg and most of the teacher rows previously did.

function coverage(rows: readonly { key: string; templates: readonly TemplateName[] }[]) {
  const map = new Map<TemplateName, string[]>();
  for (const row of rows) {
    for (const t of row.templates) {
      map.set(t, [...(map.get(t) ?? []), row.key]);
    }
  }
  return map;
}

describe("notification schedule — coverage", () => {
  it("every student-recipient template appears in exactly one student row", () => {
    const covered = coverage(STUDENT_ROWS);
    for (const t of TEMPLATE_NAMES) {
      if (isTeacherRecipientTemplate(t)) continue;
      // A retired template still renders historical rows but has no producer,
      // so there is nothing honest to say about when it arrives.
      if (isRetiredTemplate(t)) continue;
      const rows = covered.get(t) ?? [];
      expect(rows.length, `student template '${t}' is missing from the schedule`).toBeGreaterThan(
        0,
      );
      expect(
        rows.length,
        `student template '${t}' appears in multiple rows: ${rows.join(", ")}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("every teacher-recipient template appears in exactly one teacher row", () => {
    const covered = coverage(TEACHER_ROWS);
    for (const t of TEMPLATE_NAMES) {
      if (!isTeacherRecipientTemplate(t)) continue;
      if (isRetiredTemplate(t)) continue;
      const rows = covered.get(t) ?? [];
      expect(rows.length, `teacher template '${t}' is missing from the schedule`).toBeGreaterThan(
        0,
      );
      expect(
        rows.length,
        `teacher template '${t}' appears in multiple rows: ${rows.join(", ")}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("never lists a template under the wrong audience", () => {
    for (const row of STUDENT_ROWS) {
      for (const t of row.templates) {
        expect(
          isTeacherRecipientTemplate(t),
          `'${t}' in student row '${row.key}' is teacher-recipient`,
        ).toBe(false);
      }
    }
    for (const row of TEACHER_ROWS) {
      for (const t of row.templates) {
        expect(
          isTeacherRecipientTemplate(t),
          `'${t}' in teacher row '${row.key}' is student-recipient`,
        ).toBe(true);
      }
    }
  });

  it("resolves every row's copy in every registered locale", () => {
    // The copy used to be two inline language branches selected by an
    // `en: boolean` prop, so French — a registered locale since the fr catalog
    // landed — silently fell to the Spanish branch. Keys make the compiler's
    // completeness guard responsible for this instead; asserting it here as
    // well catches a key that exists but was left as an empty string.
    for (const locale of LOCALES) {
      const t = createT(locale.tag);
      for (const row of [...STUDENT_ROWS, ...TEACHER_ROWS]) {
        expect(t(row.whatKey).trim(), `row '${row.key}' has no label in ${locale.tag}`).not.toBe(
          "",
        );
        expect(t(row.whenKey).trim(), `row '${row.key}' has no timing in ${locale.tag}`).not.toBe(
          "",
        );
      }
    }
  });

  it("groups each row under the category that actually gates it", () => {
    // The grouping is a CLAIM about what a preference switch controls, and the
    // dispatcher is the only thing that decides that. A row whose declared
    // group disagreed with `templateCategory` would print an "Off" badge over
    // notifications that still arrive — or worse, an "On" over ones that don't.
    for (const row of STUDENT_ROWS) {
      for (const name of row.templates) {
        const actual = templateCategory(name) ?? ALWAYS;
        expect(actual, `student row '${row.key}' claims group '${row.group}' for '${name}'`).toBe(
          row.group,
        );
      }
    }
    for (const row of TEACHER_ROWS) {
      for (const name of row.templates) {
        const actual = teacherTemplateCategory(name) ?? ALWAYS;
        expect(actual, `teacher row '${row.key}' claims group '${row.group}' for '${name}'`).toBe(
          row.group,
        );
      }
    }
  });

  it("names every gateable group from the category catalog", () => {
    // A group heading with no label key would render the raw category id.
    const groups = new Set(
      [...STUDENT_ROWS, ...TEACHER_ROWS].map((r) => r.group).filter((g) => g !== ALWAYS),
    );
    const t = createT("en");
    for (const group of groups) {
      expect(CATEGORY_LABEL_KEYS[group], `group '${group}' has no name`).toBeTruthy();
      expect(CATEGORY_HINT_KEYS[group], `group '${group}' has no hint`).toBeTruthy();
      expect(t(CATEGORY_LABEL_KEYS[group]).trim()).not.toBe("");
    }
  });
});

describe("notification schedule — rendering", () => {
  it("reports each group's state from the reader's own prefs", async () => {
    // `growth` off, `messages` restricted to email: the reference has to say
    // both, because reading it is how someone checks what their switches did.
    const html = renderToStaticMarkup(
      await NotificationSchedule({
        audience: "teacher",
        prefs: { growth: false, channelPrefs: { messages: ["email"] } },
      }),
    ).replaceAll("&#x27;", "'");
    const t = createT("en");
    expect(html).toContain(t("web.notificationSchedule.groupOff"));
    expect(html).toContain(t("web.notificationSchedule.groupOnEmailOnly"));
    // Non-suppressible sends are grouped once, under their own heading, and
    // never carry an on/off badge they cannot honour.
    expect(html).toContain(t("web.notificationSchedule.alwaysSentGroup"));
    expect(html).toContain(t("web.notificationSchedule.cannotTurnOff"));
  });

  it("states no group state at all when the reader is not the recipient", async () => {
    // A teacher looking at her students' schedule: every student has their own
    // preferences, so a badge here would be a guess printed as a fact.
    const html = renderToStaticMarkup(await NotificationSchedule({ audience: "student" }));
    const t = createT("en");
    expect(html).not.toContain(t("web.notificationSchedule.groupOn"));
    expect(html).not.toContain(t("web.notificationSchedule.groupOff"));
    expect(html).toContain(t("web.notificationSchedule.student.classReminders.what"));
  });
});
