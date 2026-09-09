import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// What the Monday nudge actually says, on email and on push. The difference
// that justifies replacing the old Facebook-groups reminder is that this one
// names the first prepared action, so the copy is the feature.

const { renderEmail } = await import("@/lib/email/templates");
const { renderPush } = await import("@/lib/notifications/push");
const { urlButtonSuffix } = await import("@/lib/notifications/templates");

const VARS = {
  teacherName: "Alicia Moreno",
  actionCount: 5,
  firstAction: "A useful tip · Oaxaca Expats",
  minutes: 60,
  dashboardPathSuffix: "dashboard/get-students",
};

function email(languageCode: "es_MX" | "en", overrides: Partial<typeof VARS> = {}) {
  return renderEmail({
    templateName: "student_acquisition_plan_teacher",
    languageCode,
    variables: { ...VARS, ...overrides },
    actionUrl: "https://spiralclass.com/dashboard/get-students",
  });
}

describe("student_acquisition_plan_teacher — email", () => {
  it("names the first action and the time it should take, in Spanish", () => {
    const out = email("es_MX");
    expect(out.subject).toContain("5");
    expect(out.body).toContain("Alicia Moreno");
    expect(out.body).toContain("A useful tip · Oaxaca Expats");
    expect(out.body).toContain("60");
  });

  it("does the same in English", () => {
    const out = email("en");
    expect(out.subject).toContain("Your plan this week");
    expect(out.body).toContain("Start here: A useful tip · Oaxaca Expats");
  });

  it("uses the singular for a one-action week", () => {
    expect(email("en", { actionCount: 1 }).subject).toContain("1 action");
    expect(email("en", { actionCount: 2 }).subject).toContain("2 actions");
  });

  it("degrades to a generic line rather than an empty sentence", () => {
    const out = email("en", { firstAction: "" });
    expect(out.body).toContain("your first action of the week");
    expect(out.body).not.toContain("Start here: \n");
  });

  it("carries the deep link to Get Students", () => {
    expect(urlButtonSuffix("student_acquisition_plan_teacher", VARS)).toBe(
      "dashboard/get-students",
    );
    expect(email("en").body).toContain("https://spiralclass.com/dashboard/get-students");
  });
});

describe("student_acquisition_plan_teacher — push", () => {
  it("puts the first action in the body, where a notification is actually read", () => {
    const out = renderPush("student_acquisition_plan_teacher", "en", VARS);
    expect(out?.title).toBe("Your plan for the week");
    expect(out?.body).toBe("A useful tip · Oaxaca Expats");
    expect(out?.deepLink).toBe("dashboard/get-students");
  });

  it("falls back to a generic body when there is no first action", () => {
    const out = renderPush("student_acquisition_plan_teacher", "es_MX", {
      ...VARS,
      firstAction: "",
    });
    expect(out?.body).toContain("acciones listas");
  });
});
