import { describe, expect, it } from "vitest";
import { LANGUAGE_CODES, type LanguageCode } from "@spiralclass/shared";
import { renderEmail } from "@/lib/email/templates";
import { renderPush } from "@/lib/notifications/push";
import { TEMPLATE_NAMES, type TemplateName } from "@/lib/notifications/templates";

/**
 * Every email and every push, in every language, exactly as it is sent.
 *
 * The words a notification carries are decided in two long renderers
 * (lib/email/templates.ts, lib/notifications/push.ts), and a change to how
 * they pick a language touches every one of them at once. Nobody reads fifty
 * templates in three languages after a refactor. This does: it renders each
 * template and compares the result with the recorded copy, so a sentence that
 * moved, lost a word or changed language shows up as a diff with the
 * template's name on it.
 *
 * The variables are placeholders, not fixtures. Each template is rendered
 * twice — once with every variable present (`⟦name⟧`), once with every
 * variable absent — which is what reaches both arms of a template that says
 * one thing with a join link and another without. A template that cannot
 * render without its variables records that it threw, which is itself worth
 * pinning.
 *
 * Update deliberately: `pnpm --filter spiralclass-web test -- -u
 * tests/notifications/outbound-copy.golden.test.ts`, and read the diff.
 */

/** Every variable present, named after itself. */
const present = () =>
  new Proxy({} as Record<string, string>, {
    get: (_target, key) => (typeof key === "string" ? `⟦${key}⟧` : undefined),
    has: () => true,
  });

/** Every variable absent. */
const absent = () => ({}) as Record<string, string>;

function render(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return `THREW ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * What a reader reads in an HTML email: the text, with the markup gone.
 *
 * The recorded copy is about words. The branded shell around them is several
 * kilobytes of table layout per email and is pinned by its own tests
 * (tests/notifications/email-render.test.ts); recording it fifty times over
 * would bury a changed sentence under a megabyte of unchanged markup.
 */
function readableText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const section = (title: string, lines: string[]) => `=== ${title}\n${lines.join("\n")}\n`;

const URLS = {
  actionUrl: "https://app.test/action",
  unsubscribeUrl: "https://app.test/r/email-uns/token",
  notificationSettingsUrl: "https://app.test/r/notif-settings/token",
  calendarUrl: "https://calendar.test/add",
  appUrl: "https://app.test",
};

function everyRendering(language: LanguageCode): string {
  const out: string[] = [];
  for (const templateName of TEMPLATE_NAMES as readonly TemplateName[]) {
    for (const [label, variables, urls] of [
      ["with every variable", present(), URLS],
      ["with no variables", absent(), { actionUrl: null, appUrl: URLS.appUrl }],
    ] as const) {
      out.push(
        render(() => {
          const email = renderEmail({
            templateName,
            languageCode: language,
            variables: variables as never,
            ...urls,
          });
          return section(`${templateName} · email · ${label}`, [
            `subject: ${email.subject}`,
            `text: ${email.body}`,
            `html: ${readableText(email.html)}`,
          ]);
        }),
        render(() => {
          const push = renderPush(templateName, language, variables as never);
          return section(`${templateName} · push · ${label}`, [
            `title: ${push.title}`,
            `body: ${push.body}`,
          ]);
        }),
      );
    }
  }
  return out.join("\n");
}

describe("outbound copy", () => {
  it.each(LANGUAGE_CODES)("renders every email and push in %s as recorded", async (language) => {
    await expect(everyRendering(language)).toMatchFileSnapshot(
      `./__golden__/outbound-copy.${language}.txt`,
    );
  });

  // Until this copy moved into the catalog, every language but Spanish was sent
  // the English email: the templates asked "is this Spanish?" and nothing else.
  // A language that renders a template exactly as English does has not been
  // given that template.
  it.each(LANGUAGE_CODES.filter((code) => code !== "en"))(
    "gives %s a subject and a push title of its own for every template",
    (language) => {
      const english = everyRendering("en").split("\n");
      const theirs = everyRendering(language).split("\n");
      const shared = theirs.filter(
        (line, i) =>
          (line.startsWith("subject: ") || line.startsWith("title: ")) && line === english[i],
      );
      expect(shared, `${language} lines identical to English`).toEqual([]);
    },
  );
});
