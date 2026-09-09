import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The /help/[audience]/[slug] and /help/[audience] routes deep-link into the
// content registry (@spiralclass/shared) from HelpTip touchpoints all over
// the authenticated app — each audience segment MUST require the matching
// session, or a teacher-only doc becomes reachable by a logged-out visitor
// just by guessing the URL. The public /help page is the deliberate
// exception: it must stay ungated AND must only ever source from
// listPublicFaqDocs() (never the full registry), so an admin-only doc can
// never leak onto it by a careless edit.

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "..");
const HELP_DIR = join(WEB, "src", "app", "help");

const GATES = ["requireOnboardedTeacher", "requireStudent", "requireAdmin"];

describe("/help route gating", () => {
  it("gates every audience segment on [audience]/[slug]", () => {
    const src = readFileSync(join(HELP_DIR, "[audience]", "[slug]", "page.tsx"), "utf8");
    for (const gate of GATES) {
      expect(src.includes(gate), `[audience]/[slug]/page.tsx must call ${gate}`).toBe(true);
    }
  });

  it("gates every audience segment on the [audience] index", () => {
    const src = readFileSync(join(HELP_DIR, "[audience]", "page.tsx"), "utf8");
    for (const gate of GATES) {
      expect(src.includes(gate), `[audience]/page.tsx must call ${gate}`).toBe(true);
    }
  });

  it("keeps the public /help FAQ ungated", () => {
    const src = readFileSync(join(HELP_DIR, "page.tsx"), "utf8");
    for (const gate of GATES) {
      expect(src.includes(gate), `help/page.tsx (public) must NOT call ${gate}`).toBe(false);
    }
  });

  it("only ever sources the public /help FAQ from listPublicFaqDocs()", () => {
    const src = readFileSync(join(HELP_DIR, "page.tsx"), "utf8");
    expect(src.includes("listPublicFaqDocs")).toBe(true);
    expect(src.includes("listContentDocs")).toBe(false);
  });
});
