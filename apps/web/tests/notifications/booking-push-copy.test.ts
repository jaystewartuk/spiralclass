import { describe, expect, it } from "vitest";
import { renderPush } from "@/lib/notifications/push";
import { buildVariables } from "@/lib/notifications/dispatcher";

// Copy regressions for the booking notifications the student/teacher actually
// see on their lock screen:
//   1. The student confirmation push reads warmly + second-person, mirroring
//      the confirmation email (not the drier teacher-facing wording).
//   2. No template renders a double period ("p.m..") — classDateTime ends in
//      the "p.m." abbreviation, so bodies must not append a sentence period.
//   3. Names are trimmed, so a value stored as "Alicia Moreno " never renders as a
//      double space ("con Alicia Moreno  está").

// A realistic es-MX datetime — critically, it ends in the "p.m." abbreviation.
const CLASS_DT = "lunes, 6 de julio, 04:00 p.m.";

const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("booking_confirmation push (student) — warm, second-person copy", () => {
  it("addresses the student directly and names the teacher", () => {
    const r = renderPush("booking_confirmation", "es_MX", {
      teacherName: "Alicia Moreno",
      classDateTime: CLASS_DT,
      classesRemaining: "3",
      classPathSuffix: "mis-clases/x",
    });
    expect(r.title).toBe("Clase confirmada");
    expect(r.body).toContain("Tu clase con Alicia Moreno");
    expect(r.body).toContain(CLASS_DT);
    expect(r.body).toContain("3");
    // Second-person, not the teacher-facing "reservó" framing.
    expect(r.body).not.toContain("reservó");
  });

  it("English variant is second-person too", () => {
    const r = renderPush("booking_confirmation", "en", {
      teacherName: "Alicia Moreno",
      classDateTime: "Mon, Jul 6, 4:00 PM",
      classesRemaining: "1",
      classPathSuffix: "mis-clases/x",
    });
    expect(r.body).toContain("Your class with Alicia Moreno");
  });
});

describe("no double period after a 'p.m.' time", () => {
  const cases = [
    () =>
      renderPush("booking_confirmation", "es_MX", {
        teacherName: "Alicia Moreno",
        classDateTime: CLASS_DT,
        classesRemaining: "3",
        classPathSuffix: undefined,
      }),
    () =>
      renderPush("booking_created_teacher", "es_MX", {
        teacherName: "Alicia Moreno",
        studentName: "Jay Stewart",
        classDateTime: CLASS_DT,
        dashboardPathSuffix: "dashboard/classes/x",
        calendarStartIso: "2026-07-06T22:00:00.000Z",
        calendarEndIso: "2026-07-06T22:50:00.000Z",
      }),
    () =>
      renderPush("reminder_24h", "es_MX", {
        teacherName: "Alicia Moreno",
        classDateTime: CLASS_DT,
        classPathSuffix: undefined,
      }),
    () =>
      renderPush("reminder_24h_teacher", "es_MX", {
        studentName: "Jay Stewart",
        classDateTime: CLASS_DT,
        classPathSuffix: undefined,
      }),
  ];

  it.each(cases)("body #%# has no '..'", (render) => {
    expect(render().body).not.toContain("..");
  });
});

describe("teacher reminder push — teacher-voiced, names the student", () => {
  it("names the student (not the teacher) and deep-links to the dashboard class", () => {
    const r = renderPush("reminder_1h_teacher", "es_MX", {
      studentName: "Jay Stewart",
      classDateTime: CLASS_DT,
      classPathSuffix: "dashboard/classes/x",
    });
    expect(r.title).toBe("Recordatorio: En 1 hora");
    expect(r.body).toContain("Clase con Jay Stewart");
    expect(r.body).toContain(CLASS_DT);
    expect(r.deepLink).toBe("dashboard/classes/x");
  });

  it("English 5m variant reads 'Class with <student>'", () => {
    const r = renderPush("reminder_15m_teacher", "en", {
      studentName: "Jay",
      classDateTime: "Mon, Jul 6, 4:00 PM",
      classPathSuffix: "dashboard/classes/x",
    });
    expect(r.title).toBe("Reminder: In 15 minutes");
    expect(r.body).toContain("Class with Jay");
  });
});

describe("buildVariables — teacher reminder", () => {
  function fakePrisma(status = "scheduled") {
    return {
      booking: {
        findFirst: async () => ({
          id: BOOKING_ID,
          status,
          scheduledStart: new Date("2026-07-06T22:00:00Z"),
          scheduledEnd: new Date("2026-07-06T22:50:00Z"),
          student: { name: "Jay Stewart " }, // trailing space, as seen in prod
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

  it("names the student and deep-links to the teacher's dashboard class", async () => {
    const result = await buildVariables(fakePrisma(), {
      templateName: "reminder_24h_teacher",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "es-MX",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.variables as { studentName: string; classPathSuffix: string };
      expect(v.studentName).toBe("Jay Stewart");
      expect(v.classPathSuffix).toBe(`dashboard/classes/${BOOKING_ID}`);
    }
  });

  it("guards a stale send once the booking is no longer scheduled", async () => {
    const result = await buildVariables(fakePrisma("canceled_by_teacher"), {
      templateName: "reminder_15m_teacher",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "es-MX",
      storage: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe("buildVariables trims stray whitespace on names", () => {
  function fakePrisma() {
    return {
      booking: {
        findFirst: async () => ({
          id: BOOKING_ID,
          scheduledStart: new Date("2026-07-06T22:00:00Z"),
          scheduledEnd: new Date("2026-07-06T22:50:00Z"),
          student: { name: "Jay Stewart " }, // trailing space, as seen in prod
        }),
      },
    } as never;
  }

  it("trims teacherName and studentName for booking_created_teacher", async () => {
    const result = await buildVariables(fakePrisma(), {
      templateName: "booking_created_teacher",
      notification: {
        id: "n1",
        teacherId: TEACHER_ID,
        bookingId: BOOKING_ID,
        paymentId: null,
        metadata: null,
      },
      teacherName: "Alicia Moreno ", // trailing space
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "es-MX",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.variables as { teacherName: string; studentName: string };
      expect(v.teacherName).toBe("Alicia Moreno");
      expect(v.studentName).toBe("Jay Stewart");
    }
  });
});
