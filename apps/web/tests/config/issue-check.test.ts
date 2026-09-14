import { describe, expect, it } from "vitest";

import { lintIssue, pathsIn, similarIssues, tokens } from "../../../../scripts/issue-check.mjs";

// scripts/issue-check.mjs is the executable half of the /issue skill: the shape
// D-172 describes and said nothing enforced, the labels `gh issue create` would
// reject, and the gate's own leak detectors run over a draft before a public
// repository publishes it.
//
// Its failure mode is the one every guard here shares — a detector that stops
// firing reports every draft as clean. So each rule is driven with a draft that
// breaks it, not only with one that passes.
//
// Leak fixtures are assembled at runtime. Written out whole they would be found
// by the scanners that read this file, which is the right behaviour for them
// and the wrong outcome for the gate.

const DONE = "\n\n**Done when** the thing is fixed and a test holds it.";
const GOOD_TITLE = "A forgotten tenant filter still returns every teacher's rows instead of none";
const KNOWN = ["bug", "enhancement", "documentation", "ci", "accessibility", "p1", "p2", "p3"];

const lint = (title: string, body: string, labels: string[] = ["bug", "p2"]) =>
  lintIssue({ title, body, labels }, { knownLabels: KNOWN });

describe("a draft in the house shape passes", () => {
  it("has no errors and no warnings", () => {
    expect(lint(GOOD_TITLE, `Evidence: \`apps/web/src/lib/db.ts:12\`.${DONE}`)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("accepts a What done looks like section, the form #90–#96 use", () => {
    const body = "Some context.\n\n## What done looks like\n\nEvery query scoped.";
    expect(lint(GOOD_TITLE, body).errors).toEqual([]);
  });
});

describe("the title is a sentence naming the problem", () => {
  it.each([
    "fix: tenant filter returns every row for admins",
    "ci(web): the vercel job fails on every production release",
    "feat!: move the whole board into GitHub issues today",
    "[bug] the tenant filter returns every row for admins",
  ])("rejects a category prefix: %s", (title) => {
    expect(lint(title, DONE).errors.join("\n")).toMatch(/category prefix/);
  });

  it.each([
    "Fix the tenant filter so it returns no rows by default",
    "Add a check that every issue has a done line in it",
    "Investigate why the Vercel failover never deployed to production",
  ])("rejects an instruction: %s", (title) => {
    expect(lint(title, DONE).errors.join("\n")).toMatch(/instruction/);
  });

  it("rejects a title too short to say anything", () => {
    expect(lint("Tenant filter broken", DONE).errors.join("\n")).toMatch(/too short/);
  });

  it("does not mistake a sentence starting with a noun for an instruction", () => {
    // "Production", "Nothing", "Nobody" and a number all open real titles here.
    for (const title of [
      "Production still runs as the old name on Fly, so every runbook translates it",
      "Nothing builds the production image until a production deploy does",
      "264 queries reach a tenant's data without naming a tenant",
    ]) {
      expect(lint(title, DONE).errors, title).toEqual([]);
    }
  });
});

describe("the body says what done looks like", () => {
  it("rejects a draft with no end state", () => {
    expect(lint(GOOD_TITLE, "It is broken and should be better.").errors.join("\n")).toMatch(
      /Done when/,
    );
  });

  it("does not accept the words in passing", () => {
    expect(lint(GOOD_TITLE, "We will know we are done when it works.").errors).not.toEqual([]);
  });
});

describe("labels", () => {
  it("rejects a label the repository does not have", () => {
    expect(lint(GOOD_TITLE, DONE, ["bug", "p2", "security"]).errors.join("\n")).toMatch(
      /"security" does not exist/,
    );
  });

  it("rejects two priorities", () => {
    expect(lint(GOOD_TITLE, DONE, ["bug", "p1", "p3"]).errors.join("\n")).toMatch(
      /more than one priority/,
    );
  });

  it("warns, without failing, when priority or type is missing", () => {
    const { errors, warnings } = lint(GOOD_TITLE, DONE, []);
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/no priority label/);
    expect(warnings.join("\n")).toMatch(/no type label/);
  });

  it("skips the existence check when it has no label list", () => {
    expect(lintIssue({ title: GOOD_TITLE, body: DONE, labels: ["anything"] }).errors).toEqual([]);
  });
});

describe("leaks are caught before the repository publishes them", () => {
  it("a credential", () => {
    const key = ["sk", "live", "Q".repeat(28)].join("_");
    const { errors } = lint(GOOD_TITLE, `Log line: ${key}${DONE}`);
    expect(errors.join("\n")).toMatch(/possible credential/);
    // The finding names the kind, never the value — this output is a transcript.
    expect(errors.join("\n")).not.toContain(key);
  });

  it("a connection string with a real-looking password", () => {
    const url = "postgresql://app:" + "correcthorsebattery" + "@db.internal/app";
    expect(lint(GOOD_TITLE, `${url}${DONE}`).errors.join("\n")).toMatch(/possible credential/);
  });

  it("a personal email address", () => {
    const email = "maria.alumna" + "@" + "gmail.com";
    const { errors } = lint(GOOD_TITLE, `Reported by ${email}${DONE}`);
    expect(errors.join("\n")).toMatch(/personal email/);
    expect(errors.join("\n")).not.toContain(email);
  });

  it("an undeclared person's name", () => {
    const name = "Beatriz " + "Undeclarada";
    expect(lint(GOOD_TITLE, `${name} could not book.${DONE}`).errors.join("\n")).toMatch(
      /undeclared person name/,
    );
  });

  it("a fixture address is not personal data", () => {
    expect(lint(GOOD_TITLE, `Seeded as teacher@example.com.${DONE}`).errors).toEqual([]);
  });
});

describe("similar issues", () => {
  const existing = [
    {
      number: 104,
      title:
        "The Vercel failover has never deployed, because its three credentials were never provisioned",
      body: "Pins a region in `config/vercel/production.json`.",
      state: "OPEN",
    },
    {
      number: 93,
      title: "A forgotten tenant filter still returns every teacher's rows instead of none",
      body: "",
      state: "CLOSED",
      stateReason: "COMPLETED",
    },
    {
      number: 7,
      title: "The help centre search box ignores accents in Spanish articles",
      body: "",
      state: "OPEN",
    },
  ];

  it("ranks a reworded duplicate first, and finds closed issues too", () => {
    const vercel = similarIssues(
      { title: "The Vercel failover job fails because it has no credentials", body: "" },
      existing,
    );
    expect(vercel[0]?.number).toBe(104);

    const tenant = similarIssues(
      { title: "Tenant filter forgotten returns rows for every teacher", body: "" },
      existing,
    );
    expect(tenant[0]?.number).toBe(93);
  });

  it("counts a shared file path", () => {
    const [top] = similarIssues(
      {
        title: "Region pinned without evidence",
        body: "See `config/vercel/production.json:3`.",
      },
      existing,
    );
    expect(top?.number).toBe(104);
    expect(top?.sharedPaths).toEqual(["config/vercel/production.json"]);
  });

  it("returns nothing for an unrelated draft rather than padding the list", () => {
    expect(
      similarIssues(
        { title: "Lesson reminders arrive an hour late after daylight saving", body: "" },
        existing,
      ),
    ).toEqual([]);
  });

  it("tokenises without stopwords, and reads paths out of backticks", () => {
    expect([...tokens("The filter still returns every row")]).toEqual(["filter", "returns", "row"]);
    expect([...pathsIn("in `apps/web/src/a.ts:10` and `not-a-path`")]).toEqual([
      "apps/web/src/a.ts",
    ]);
  });
});
