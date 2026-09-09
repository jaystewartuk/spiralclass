import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// Web mirror of the mobile HomeworkStatusBadge (student web class-detail
// Homework card, added by the class-detail redesign). SSR-level checks pin:
// it takes `t` as a prop rather than calling a client hook, so it stays a
// plain Server Component like booking-status-badge.tsx, and every status maps
// to a rendered label with no thrown/undefined case.

const { HomeworkStatusBadge } = await import("@/components/homework-status-badge");

const t = (key: string) => key;

describe("HomeworkStatusBadge", () => {
  it.each(["not_submitted", "draft", "submitted", "late", "returned", "graded"] as const)(
    "renders a label for status %s",
    (status) => {
      const html = renderToStaticMarkup(React.createElement(HomeworkStatusBadge, { status, t }));
      expect(html).toContain(`homework.status.${status}`);
    },
  );
});
