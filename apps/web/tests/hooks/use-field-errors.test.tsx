import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { useFieldErrors } from "@/hooks/use-field-errors";

// `clearError` sits in effect deps (ai-generate-flow.tsx, material-form.tsx).
// When it was a fresh function per render, those effects re-ran after every
// keystroke and each scheduled a no-op update; typing fast enough into the
// AI-material topic field threw React #185 ("Maximum update depth exceeded")
// on the ~53rd character and dropped it (Sentry AGENDAPROFE-3S).
//
// The unit suite has no DOM, so the component re-renders through a
// render-phase update, which the server renderer supports while keeping hook
// state — enough to compare the identity `clearError` has across two renders.

function renderTwice(): Array<(key: "topic") => void> {
  const seen: Array<(key: "topic") => void> = [];
  function Probe() {
    const { clearError } = useFieldErrors<"topic">();
    const [pass, setPass] = React.useState(0);
    seen.push(clearError);
    if (pass === 0) setPass(1);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return seen;
}

describe("useFieldErrors", () => {
  it("returns the same clearError on every render, so effects that depend on it don't re-run", () => {
    const seen = renderTwice();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });
});
