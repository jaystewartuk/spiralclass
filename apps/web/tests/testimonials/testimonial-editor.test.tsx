// @vitest-environment jsdom
//
// The teacher's testimonial editor. Two things this screen gets wrong when it
// regresses, both invisible to a type check:
//
//  1. It stops being READABLE. Every testimonial used to render as four
//     expanded inputs, so the answer to "what do my students say about me?"
//     was buried in form state. The quote itself must be on the card.
//  2. The reorder arrows stop matching the ends of the list. `sortOrder` is
//     public — it decides which quote a visitor reads first — and an arrow
//     that is live at the top of the list posts a move the server can only
//     refuse.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
// Type-only, so it is erased before the mocks below take effect.
import type { TestimonialItem } from "@/app/(app)/dashboard/testimonials/testimonial-forms";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

// The actions are "use server" modules that reach for prisma; the editor only
// needs them to be functions it can hand to useActionState.
vi.mock("@/app/actions/testimonials", () => ({
  addTestimonial: vi.fn(),
  updateTestimonial: vi.fn(),
  setTestimonialPublished: vi.fn(),
  moveTestimonial: vi.fn(),
  deleteTestimonial: vi.fn(),
  deleteTestimonialPhoto: vi.fn(),
}));

const { AddTestimonialPanel, TestimonialCard } =
  await import("@/app/(app)/dashboard/testimonials/testimonial-forms");

const ITEM: TestimonialItem = {
  id: "11111111-1111-4111-8111-111111111111",
  authorName: "Sofía",
  authorNote: "B2 · 6 months",
  body: "She fixed my pronunciation in three weeks.",
  published: true,
  photoPath: null,
  source: "teacher_curated",
  verifiedAt: null,
};

// The other kind: written by the student, vouched for by the platform. She may
// hide or delete it; she may never write or edit it (D-151).
const VERIFIED: TestimonialItem = {
  ...ITEM,
  id: "22222222-2222-4222-8222-222222222222",
  source: "student_submitted",
  verifiedAt: new Date("2026-09-01T00:00:00Z"),
};

describe("the testimonial editor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // A fresh mount per call: `AddTestimonialPanel` seeds its open/closed state
  // from props at mount, so re-rendering into the same root would assert
  // against the previous case's state rather than the one under test.
  function render(node: React.ReactNode) {
    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(node));
  }

  /** The buttons labelled by a given catalog key, in DOM order. */
  function buttonsLabelled(key: string): HTMLButtonElement[] {
    return [...container.querySelectorAll("button")].filter((button) =>
      button.textContent?.includes(key),
    ) as HTMLButtonElement[];
  }

  it("shows the quote itself, not just a form", () => {
    render(<TestimonialCard item={ITEM} index={0} total={1} />);

    const quote = container.querySelector("blockquote");
    expect(quote?.textContent).toBe(ITEM.body);
    expect(container.querySelector("figcaption")?.textContent).toContain("Sofía");
    expect(container.querySelector("figcaption")?.textContent).toContain("B2 · 6 months");
  });

  it("gives a verified testimonial no edit affordance at all", () => {
    // The server filters every teacher-side write on `teacher_curated` and a
    // CHECK constraint backs it up. This asserts the UI says the same thing,
    // so she is never offered an edit that would be refused.
    render(<TestimonialCard item={VERIFIED} index={0} total={1} />);
    expect(container.textContent).not.toContain("web.dashboard.testimonials.edit");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("web.dashboard.testimonials.verifiedLocked");
  });

  it("still lets her hide or delete a verified testimonial", () => {
    // Hiding and deleting are hers: the words are the student's, the page is
    // hers. Removing the edit form must not remove these.
    render(<TestimonialCard item={VERIFIED} index={0} total={1} />);
    expect(container.textContent).toContain("web.dashboard.testimonials.deleteAction");
  });

  it("offers no reordering when there is only one testimonial", () => {
    render(<TestimonialCard item={ITEM} index={0} total={1} />);

    expect(buttonsLabelled("web.dashboard.testimonials.moveUp")).toHaveLength(0);
    expect(buttonsLabelled("web.dashboard.testimonials.moveDown")).toHaveLength(0);
  });

  it("disables the arrow that points off the end of the list", () => {
    render(<TestimonialCard item={ITEM} index={0} total={3} />);
    expect(buttonsLabelled("web.dashboard.testimonials.moveUp")[0].disabled).toBe(true);
    expect(buttonsLabelled("web.dashboard.testimonials.moveDown")[0].disabled).toBe(false);

    render(<TestimonialCard item={ITEM} index={2} total={3} />);
    expect(buttonsLabelled("web.dashboard.testimonials.moveUp")[0].disabled).toBe(false);
    expect(buttonsLabelled("web.dashboard.testimonials.moveDown")[0].disabled).toBe(true);

    render(<TestimonialCard item={ITEM} index={1} total={3} />);
    expect(buttonsLabelled("web.dashboard.testimonials.moveUp")[0].disabled).toBe(false);
    expect(buttonsLabelled("web.dashboard.testimonials.moveDown")[0].disabled).toBe(false);
  });

  it("offers Publish on a hidden testimonial and Hide on a live one", () => {
    render(<TestimonialCard item={{ ...ITEM, published: false }} index={0} total={1} />);
    expect(buttonsLabelled("web.dashboard.testimonials.publish")).toHaveLength(1);
    expect(container.textContent).toContain("web.dashboard.testimonials.hidden");

    render(<TestimonialCard item={ITEM} index={0} total={1} />);
    expect(buttonsLabelled("web.dashboard.testimonials.hide")).toHaveLength(1);
    expect(container.textContent).toContain("web.dashboard.testimonials.published");
  });

  it("keeps the editor folded until it is asked for", () => {
    render(<TestimonialCard item={ITEM} index={0} total={1} />);

    const region = container.querySelector("[aria-expanded]")?.getAttribute("aria-controls");
    expect(container.querySelector(`#${region}`)?.hasAttribute("hidden")).toBe(true);
  });

  it("hides the remove-photo control when there is no photo to remove", () => {
    render(<TestimonialCard item={ITEM} index={0} total={1} />);
    expect(buttonsLabelled("web.dashboard.testimonials.removePhoto")).toHaveLength(0);

    render(
      <TestimonialCard item={{ ...ITEM, photoPath: "t1/testimonials/x" }} index={0} total={1} />,
    );
    expect(buttonsLabelled("web.dashboard.testimonials.removePhoto")).toHaveLength(1);
  });

  it("opens the add form as the empty state, and folds it away once there is a list", () => {
    render(<AddTestimonialPanel hasItems={false} />);
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.textContent).toContain("web.dashboard.testimonials.addFirst");
    expect(container.textContent).toContain("web.dashboard.testimonials.emptyBody");

    render(<AddTestimonialPanel hasItems />);
    expect(container.querySelector("form")).toBeNull();
    expect(buttonsLabelled("web.dashboard.testimonials.addTestimonial")).toHaveLength(1);
  });
});
