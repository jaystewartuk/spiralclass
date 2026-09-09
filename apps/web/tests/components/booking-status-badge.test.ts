// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { badgeVariants } from "@/components/ui/badge";

// The components compile with the classic JSX runtime (React must be in scope).
(globalThis as Record<string, unknown>).React = React;

// The class-card status chips were retoned into the terracotta family: the
// scheduled chip moved off the cold blue `info` onto the earthy `clay`, and the
// has-materials chip off the cool green `success` onto `sage`. The no-materials
// chip stays on the already-earthy ochre `warning`. i18n is mocked to echo the
// key so the assertions key off the colour classes, not the copy.
vi.mock("@/lib/i18n", () => ({
  getT: async () => (key: string) => key,
}));

const { BookingStatusBadge, MaterialsBadge } = await import("@/components/booking-status-badge");

describe("badge variants", () => {
  it("sits every accent on its SOLVED tinted ground, not an opacity", () => {
    // Was `bg-clay/15`: the accent composited at 15% over whatever is behind
    // it, which is a different colour from the one the contrast test checks —
    // and axe caught the success variant of it failing AA on the dashboard.
    // The `-bg` tokens are solved against their own foreground.
    for (const variant of ["clay", "sage", "success", "warning", "info"] as const) {
      expect(badgeVariants({ variant })).toContain(`bg-${variant}-bg`);
      expect(badgeVariants({ variant })).toContain(`text-${variant}`);
      expect(
        badgeVariants({ variant }),
        `${variant} is back on an opacity — that colour is not the one the contrast test asserts`,
      ).not.toContain(`bg-${variant}/`);
    }
  });
});

describe("BookingStatusBadge / MaterialsBadge earthy remap", () => {
  it("renders the scheduled status chip in clay (not the old cold blue info)", async () => {
    const html = renderToStaticMarkup(
      await BookingStatusBadge({ status: "scheduled", viewer: "teacher" }),
    );
    expect(html).toContain("text-clay");
    expect(html).not.toContain("text-info");
  });

  it("renders the has-materials chip in sage", async () => {
    const html = renderToStaticMarkup(
      await MaterialsBadge({ hasMaterials: true, status: "scheduled" }),
    );
    expect(html).toContain("text-sage");
  });

  it("keeps the no-materials chip on the earthy ochre warning", async () => {
    const html = renderToStaticMarkup(
      await MaterialsBadge({ hasMaterials: false, status: "scheduled" }),
    );
    expect(html).toContain("text-warning");
  });
});
