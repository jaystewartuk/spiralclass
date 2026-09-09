import { describe, expect, it } from "vitest";
import { rewriteHelpDocLinks } from "./links";

const toRoute = (slug: string) => `/help/teacher/${slug}`;
const drop = () => null;

describe("rewriteHelpDocLinks", () => {
  it("points a relative doc link at the resolved destination", () => {
    expect(rewriteHelpDocLinks("See [Create packages](packages-and-payments.md).", toRoute)).toBe(
      "See [Create packages](/help/teacher/packages-and-payments).",
    );
  });

  it("resolves a translated sibling to the same slug", () => {
    expect(rewriteHelpDocLinks("[Crea paquetes](packages-and-payments.es-MX.md)", toRoute)).toBe(
      "[Crea paquetes](/help/teacher/packages-and-payments)",
    );
  });

  it("unwraps to plain text when there is no destination", () => {
    expect(rewriteHelpDocLinks("See [Create packages](packages-and-payments.md).", drop)).toBe(
      "See Create packages.",
    );
  });

  it("leaves an absolute link untouched", () => {
    const src = "See [Stripe's pricing](https://stripe.com/pricing).";
    expect(rewriteHelpDocLinks(src, drop)).toBe(src);
  });

  it("leaves a link that already points at a route untouched", () => {
    const src = "See [pricing](/pricing).";
    expect(rewriteHelpDocLinks(src, drop)).toBe(src);
  });

  it("rewrites every occurrence, not just the first", () => {
    const out = rewriteHelpDocLinks("[A](a.md) and [B](b.md)", drop);
    expect(out).toBe("A and B");
  });

  it("leaves the markdown alone when it holds no doc links", () => {
    expect(rewriteHelpDocLinks("Plain **text**.", toRoute)).toBe("Plain **text**.");
  });
});
