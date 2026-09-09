import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { ToggleField } from "@/components/ui/toggle-field";

(globalThis as Record<string, unknown>).React = React;

// The three self-submitting settings toggles were each a bare
// `<input type="checkbox" className="h-4 w-4">` with the explanation in a
// sibling <p>. Two defects, both invisible to a sighted mouse user and both
// fixed once here rather than four times at the call sites.

function render(props: Partial<React.ComponentProps<typeof ToggleField>> = {}) {
  return renderToStaticMarkup(
    React.createElement(ToggleField, {
      name: "shared",
      checked: false,
      onCheckedChange: () => {},
      label: "Share progress with my students",
      hint: "Applies to all your current students.",
      ...props,
    }),
  );
}

describe("ToggleField", () => {
  it("names the control with its label, through a real for/id pair", () => {
    const html = render();
    const id = /<input[^>]*id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
  });

  it("wires the hint in as the control's description, not just as nearby text", () => {
    const html = render();
    const describedBy = /<input[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain("Applies to all your current students.");
  });

  it("omits the description wiring entirely when there is no hint", () => {
    expect(render({ hint: undefined })).not.toContain("aria-describedby");
  });

  it("stays a native checkbox, since every caller submits it as form data", () => {
    const html = render({ name: "available", checked: true });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="available"');
    expect(html).toContain("checked");
  });

  it("gives the switch a 44px target, the floor D-140 sets", () => {
    // The visible track is 24px tall; the label around it is what the finger
    // hits. Asserting the class is crude, but it is the only place the size is
    // stated, and the alternative is a rule that quietly regresses.
    expect(render()).toMatch(/class="[^"]*\bh-11 w-11\b/);
  });

  it("renders the inline save status a buttonless form has no other way to show", () => {
    const html = render({ status: React.createElement("p", null, "Saved.") });
    expect(html).toContain("Saved.");
  });
});
