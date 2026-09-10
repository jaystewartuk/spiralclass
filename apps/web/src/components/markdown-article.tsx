import { Heading } from "@/components/ui/heading";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { ElementType, ReactNode } from "react";

/**
 * How far to push this markdown's headings down the document outline.
 *
 * The help centre renders a doc SECTION at a time, under a heading the page
 * supplies — so the `###` inside that section is the fourth level of the
 * outline, not the third. The offset moves the TAG only; the visual size is
 * unchanged, which is the same separation `Heading` makes between `level` and
 * `as` and for the same reason: the outline is an accessibility concern and
 * the size is a design one.
 */
const TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function shift(base: 1 | 2 | 3, offset: number): ElementType {
  return TAGS[Math.min(base - 1 + offset, TAGS.length - 1)];
}

function buildComponents(offset: number): Components {
  const H1 = shift(1, offset);
  const H2 = shift(2, offset);
  const H3 = shift(3, offset);

  return {
    h1: ({ children }) => (
      <H1 className="text-foreground mt-10 mb-4 text-3xl font-bold">{children}</H1>
    ),
    h2: ({ children }) => (
      <H2 className="border-border text-foreground mt-10 mb-3 border-b pb-2 text-2xl font-semibold">
        {children}
      </H2>
    ),
    h3: ({ children }) => (
      // 19px, not the 17px of body copy: a heading set at the size and colour
      // of the paragraph under it is not a heading, and `###` is where these
      // documents keep their real structure — every "Steps" section in
      // docs/help is a list of them.
      <Heading level={3} as={H3} className="text-foreground mt-6 mb-2">
        {children}
      </Heading>
    ),
    p: ({ children }) => <p className="text-muted-foreground mb-4 leading-relaxed">{children}</p>,
    ul: ({ children }) => (
      <ul className="text-muted-foreground mb-4 list-disc space-y-1 pl-6">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="text-muted-foreground mb-4 list-decimal space-y-1 pl-6">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => <strong className="text-foreground font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    a: ({ href, children }) => {
      // An off-site link opens in a new tab and says so to a screen reader.
      // In-app links (the help centre's own cross-references) navigate in
      // place, which is what a reader following a "see also" expects.
      const external = /^https?:\/\//.test(href ?? "");
      return (
        <a
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="text-primary hover:text-foreground rounded-sm underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
    hr: () => <hr className="border-border my-8" />,
    blockquote: ({ children }) => (
      <blockquote className="border-border text-muted-foreground my-4 border-l-4 pl-4">
        {children}
      </blockquote>
    ),
    code: ({ children }) => (
      <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{children}</code>
    ),
    table: ({ children }) => (
      <div className="mb-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
    th: ({ children }) => (
      <th className="border-border text-foreground border px-4 py-2 text-left font-medium">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-border text-muted-foreground border px-4 py-2 leading-relaxed">
        {children}
      </td>
    ),
  };
}

// Built once per offset rather than per render: the object identity is what
// react-markdown memoises against, and rebuilding it on every render of a page
// that holds thirty of these throws that away.
const BY_OFFSET = new Map<number, Components>();
function componentsFor(offset: number): Components {
  let cached = BY_OFFSET.get(offset);
  if (!cached) {
    cached = buildComponents(offset);
    BY_OFFSET.set(offset, cached);
  }
  return cached;
}

// Themed markdown renderer shared by every brand-styled markdown page (the
// PRD viewer, the in-app help center) so their Tailwind treatment of each
// markdown element can't drift apart across copies.
export function MarkdownArticle({
  content,
  headingOffset = 0,
}: {
  content: string;
  /** Push every heading down the outline by this many levels — see TAGS. */
  headingOffset?: number;
}): ReactNode {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={componentsFor(headingOffset)}>
      {content}
    </ReactMarkdown>
  );
}
