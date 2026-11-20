import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sentryEnvironment } from "@/lib/sentry-environment";

import { REPO_ROOT } from "./_tree";

/**
 * A session can reach production evidence from CLAUDE.md in one link, and the
 * filters that page tells it to use are the ones the code actually sends.
 *
 * WHY THIS EXISTS (#256). Nothing told a session where production errors,
 * usage or logs live, so it either guessed at a cause or read the wrong data.
 * The sharpest case is usage: an operator's test traffic reads as real teachers
 * unless the `is_test_account` person property is filtered out, and PostHog's
 * own "filter out test accounts" switch does not key on that property in this
 * project — so the page has to name it, and the name has to stay true.
 *
 * Each assertion below ties a sentence in the page to the source that makes it
 * true, so renaming the property, the Sentry tag or the environment fails here
 * rather than leaving the page quietly wrong.
 */

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const PAGE = "docs/development/production-evidence.md";

describe("production evidence is one link from CLAUDE.md", () => {
  it("the page exists", () => {
    expect(existsSync(join(REPO_ROOT, PAGE)), `${PAGE} is missing`).toBe(true);
  });

  it("CLAUDE.md's orientation table links to it", () => {
    expect(read("CLAUDE.md")).toContain(`](${PAGE})`);
  });

  it("the development folder's README lists it", () => {
    expect(read("docs/development/README.md")).toContain("](production-evidence.md)");
  });
});

describe("the filters the page names are the ones the code sends", () => {
  const page = () => read(PAGE);

  it("names `is_test_account`, which both identify paths set", () => {
    expect(page()).toContain("`is_test_account`");
    expect(read("apps/web/src/lib/analytics/posthog.ts")).toContain(
      "personProps.is_test_account =",
    );
    expect(read("apps/web/src/components/posthog-identify.tsx")).toContain(
      "setPersonProperties({ is_test_account:",
    );
  });

  it("names the database's own test-account definition", () => {
    expect(page()).toContain("apps/web/src/lib/marketing/test-accounts.ts");
    expect(read("apps/web/src/lib/marketing/test-accounts.ts")).toMatch(
      /export const NOT_TEST_ACCOUNT\b/,
    );
  });

  it("names the Sentry environment and the `surface` tag the logger sets", () => {
    expect(page()).toContain("`environment:production`");
    const before = process.env.APP_URL;
    process.env.APP_URL = "https://www.example.com";
    try {
      expect(sentryEnvironment()).toBe("production");
    } finally {
      if (before === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = before;
    }
    expect(page()).toContain("`surface`");
    expect(read("apps/web/src/lib/logger.ts")).toContain("tags: stringTags(base)");
  });

  it("names the JSON fields the logger writes, which Cloud Logging parses", () => {
    const logger = read("apps/web/src/lib/logger.ts");
    expect(logger).toContain("const line = { level, msg: message, ...base");
    for (const field of ["jsonPayload.level", "jsonPayload.surface", "jsonPayload.msg"]) {
      expect(page()).toContain(field);
    }
  });
});
