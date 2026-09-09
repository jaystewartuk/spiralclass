import { describe, expect, it } from "vitest";
import { buildVariables } from "@/lib/notifications/dispatcher";

// Regression test for a real bug found in a timezone audit: every
// notification date variable was rendered via `formatDateTimeInZone(date,
// ctx.teacherTimezone)`, so a STUDENT-recipient email/push/in-app copy always
// showed the class time in the TEACHER's zone — e.g. a teacher in
// America/Mexico_City and a student in Europe/Madrid both saw "12:00 p.m." for
// an 18:00 UTC class, even though the student's actual local time was 8:00
// p.m. `buildVariables` now takes `recipientTimezone`/`recipientLocale`
// (the actual recipient's, resolved per-recipient by the dispatcher/inbox call
// sites — see dispatcher.ts, inbox-queries.ts) instead of always the
// teacher's — this locks that in.

const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakePrisma() {
  return {
    booking: {
      findFirst: async () => ({
        id: BOOKING_ID,
        status: "scheduled",
        // 18:00 UTC — noon in Mexico City (UTC-6), 8:00 p.m. in Madrid
        // (UTC+2, CEST in July).
        scheduledStart: new Date("2026-07-06T18:00:00Z"),
        scheduledEnd: new Date("2026-07-06T18:50:00Z"),
        student: { name: "Jay Stewart" },
      }),
    },
  } as never;
}

const notification = {
  id: "n1",
  teacherId: TEACHER_ID,
  bookingId: BOOKING_ID,
  paymentId: null,
  metadata: null,
};

describe("buildVariables renders dates in the actual recipient's zone", () => {
  it("a student-recipient template shows the STUDENT's local time, not the teacher's", async () => {
    const asTeacherZone = await buildVariables(fakePrisma(), {
      templateName: "materials_send",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "es-MX",
      storage: null,
    });
    const asStudentZone = await buildVariables(fakePrisma(), {
      templateName: "materials_send",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "Europe/Madrid",
      recipientLocale: "es-MX",
      storage: null,
    });
    expect(asTeacherZone.ok).toBe(true);
    expect(asStudentZone.ok).toBe(true);
    if (!asTeacherZone.ok || !asStudentZone.ok) return;

    const mxCity = (asTeacherZone.variables as { classDateTime: string }).classDateTime;
    const madrid = (asStudentZone.variables as { classDateTime: string }).classDateTime;

    // Same instant, different wall clocks — buildVariables must reflect
    // whatever zone it was actually asked to render in.
    expect(mxCity).not.toBe(madrid);
    expect(mxCity).toContain("12:00"); // noon in Mexico City
    // 8:00 p.m. in Madrid. 8, not 08 — the hour carries no leading zero in a 12-hour locale (packages/shared/src/time-format.ts).
    expect(madrid).toContain("8:00");
  });

  it("renders in the recipient's own locale, not a hardcoded default", async () => {
    const es = await buildVariables(fakePrisma(), {
      templateName: "materials_send",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "Europe/Madrid",
      recipientLocale: "es-MX",
      storage: null,
    });
    const en = await buildVariables(fakePrisma(), {
      templateName: "materials_send",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "Europe/Madrid",
      recipientLocale: "en",
      storage: null,
    });
    expect(es.ok).toBe(true);
    expect(en.ok).toBe(true);
    if (!es.ok || !en.ok) return;
    const esDt = (es.variables as { classDateTime: string }).classDateTime;
    const enDt = (en.variables as { classDateTime: string }).classDateTime;
    // Spanish long-form weekday/month vs English — different strings for the
    // same instant/zone confirms the locale argument is actually threaded
    // through (previously always defaulted to "es-MX", ignoring the
    // recipient's real locale).
    expect(esDt).not.toBe(enDt);
    expect(esDt.toLowerCase()).toContain("lunes");
    expect(enDt.toLowerCase()).toContain("monday");
  });
});
