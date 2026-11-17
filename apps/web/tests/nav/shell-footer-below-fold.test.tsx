// The student portal jumped as every page loaded (#90). The root layout renders
// the site footer after each audience's shell; a route's loading.tsx skeleton
// is shorter than its page, so on every in-app navigation the footer rose into
// view under the skeleton and dropped back when the content streamed in —
// 0.32 CLS on the class page alone, measured at a 384px phone width.
//
// Each shell is held at least a screen tall so the footer always starts below
// the fold. tests/e2e/portal-layout-shift.spec.ts measures the shift itself in
// a real browser; this pins the mechanism in the fast tier, so removing the
// floor fails here before it reaches a heavy run.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getCurrentStudent: async () => ({
    id: "s1",
    name: "Sofía",
    email: "sofia@example.test",
    photoPath: null,
    timezone: "America/Mexico_City",
  }),
  requireTeacher: async () => ({
    id: "t1",
    name: "Alicia",
    email: "alicia@example.test",
    photoPath: null,
    updatedAt: new Date(0),
    bookingSlug: "alicia",
    testAccount: false,
    country: null,
    pricingCurrency: "MXN",
  }),
}));
vi.mock("@/lib/storage/student-photo", () => ({ studentPhotoUrl: async () => null }));
vi.mock("@/lib/storage/teacher-photo", () => ({ teacherPhotoPublicUrl: () => null }));
vi.mock("@/lib/notifications/inbox-queries", () => ({ getTeacherInboxUnreadCount: async () => 0 }));
vi.mock("@/components/language-picker", () => ({ LanguagePicker: () => null }));
vi.mock("@/components/posthog-identify", () => ({ PostHogIdentify: () => null }));
vi.mock("@/app/(app)/app-nav", () => ({ AppNav: () => null }));
vi.mock("@/app/(app)/subscription-banner", () => ({ SubscriptionBanner: () => null }));
vi.mock("@/app/(student)/my-classes/student-nav", () => ({ StudentNav: () => null }));
vi.mock("@/app/(student)/my-classes/capture-timezone", () => ({ CaptureTimezone: () => null }));
vi.mock("@/app/(student)/my-classes/timezone-mismatch-notice", () => ({
  TimezoneMismatchNotice: () => null,
}));
const pathname = { value: "/dashboard" };
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-pathname": pathname.value }),
}));

const { default: StudentPortalLayout } = await import("@/app/(student)/my-classes/layout");
const { default: TeacherAppLayout } = await import("@/app/(app)/layout");

type Props = { className?: string; children?: ReactNode };

/** The first host element (a plain tag like "div") down the tree, skipping providers. */
function firstHostElement(node: ReactNode): ReactElement<Props> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = firstHostElement(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Props>(node)) return null;
  if (typeof node.type === "string") return node;
  return firstHostElement(node.props.children);
}

const CHILD = <p>page</p>;

describe("each signed-in shell keeps the site footer below the fold", () => {
  it("the student portal shell is at least a screen tall around the nav and the page", async () => {
    const shell = await StudentPortalLayout({ children: CHILD });
    expect(shell.type).toBe("div");
    expect(shell.props.className?.split(" ")).toContain("min-h-dvh");
  });

  it("the teacher app's content column is at least a screen tall", async () => {
    pathname.value = "/dashboard/classes/abc";
    const content = firstHostElement(await TeacherAppLayout({ children: CHILD }));
    expect(content?.props.className?.split(" ")).toContain("min-h-dvh");
  });

  it("keeps the floor on onboarding too, where the sidebar offset is dropped", async () => {
    pathname.value = "/onboarding";
    const content = firstHostElement(await TeacherAppLayout({ children: CHILD }));
    expect(content?.props.className?.split(" ")).toContain("min-h-dvh");
  });
});
