"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  BookMarked,
  BookOpen,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  House,
  Info,
  Languages,
  Lightbulb,
  ListChecks,
  PencilLine,
  Pin,
  Square,
  SquareCheck,
  StickyNote,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  calloutMeta,
  COLLAPSIBLE_CALLOUTS,
  materialImageRoutePath,
  parseMaterialDoc,
  resolveMaterialImageSrc,
  timelineGeometry,
  type CalloutVariant,
  type InlineNode,
  type ListItem,
  type MaterialBlock,
  type TimelineBlock,
} from "@spiralclass/shared";

import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

// The web renderer for AI-generated class materials — the reference
// implementation of the shared document design system. It walks the canonical
// MaterialDoc tree (parsed once in @spiralclass/shared, the SAME tree the mobile
// and PDF renderers consume) and maps each semantic block to a brand-styled
// element. All copy resolves through the i18n catalog; all colour comes from the
// theme CSS variables (so light/dark switch for free); typography uses the
// display face (Fraunces) for headings and the sans face for body, at a reading
// rhythm tuned for a live lesson.
//
// This is a client component: semantic callouts like "answer" collapse on tap so
// they never dominate the exercise flow, and the label copy needs useT(). RSC
// pages render it across a client boundary — the `body` string is serialisable.
//
// Security: it never renders raw HTML (the parser has no HTML sink — the D-17
// sanitisation boundary) and every link href passes the scheme allow-list below.

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

// lucide component per callout icon name (from CALLOUT_META). Kept explicit so
// the bundler tree-shakes to just these icons. Exported so the per-block
// callout editor (block-editor.tsx, MATERIAL_EDITING phase 4) can render the
// SAME icon in its variant picker instead of a second icon map that could
// drift from this one.
export const ICONS: Record<string, LucideIcon> = {
  StickyNote,
  Info,
  Lightbulb,
  CircleAlert,
  TriangleAlert,
  Pin,
  BookOpen,
  PencilLine,
  CircleHelp,
  CircleCheck,
  BookMarked,
  Languages,
  ListChecks,
  House,
};

// Palette-token → theme CSS-variable name. The parser's callout role is a brand
// palette key; here it becomes the `--var` the tint/border/text derive from, so
// a callout re-tints itself in dark mode with no extra code.
const ROLE_VAR: Record<string, string> = {
  info: "info",
  success: "success",
  warning: "warning",
  danger: "destructive",
  accent: "accent",
  primary: "primary",
  clay: "clay",
  sage: "sage",
  borderStrong: "muted-foreground",
};

function roleStyles(role: string): { wrap: CSSProperties; accent: CSSProperties } {
  const v = ROLE_VAR[role] ?? "muted-foreground";
  return {
    // A subtle wash + hairline border + a stronger left rule, all from one hue.
    wrap: {
      backgroundColor: `hsl(var(--${v}) / 0.07)`,
      borderColor: `hsl(var(--${v}) / 0.22)`,
      borderLeftColor: `hsl(var(--${v}))`,
    },
    accent: { color: `hsl(var(--${v}))` },
  };
}

// --- inline -----------------------------------------------------------------

function Inlines({ nodes }: { nodes: InlineNode[] }): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <span key={i}>{node.value}</span>;
      case "strong":
        return (
          <strong key={i} className="font-semibold text-foreground">
            <Inlines nodes={node.children} />
          </strong>
        );
      case "em":
        return (
          <em key={i} className="italic">
            <Inlines nodes={node.children} />
          </em>
        );
      case "code":
        return (
          <code
            key={i}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
          >
            {node.value}
          </code>
        );
      case "link": {
        const safe = SAFE_LINK.test(node.href.trim());
        if (!safe)
          return (
            <span key={i}>
              <Inlines nodes={node.children} />
            </span>
          );
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
          >
            <Inlines nodes={node.children} />
          </a>
        );
      }
    }
  });
}

// --- blocks -----------------------------------------------------------------

function ListItemRow({
  item,
  ordered,
  index,
}: {
  item: ListItem;
  ordered: boolean;
  index: number;
}) {
  const marker =
    item.checked !== null ? (
      item.checked ? (
        <SquareCheck className="mt-0.5 size-[1.05em] shrink-0 text-primary" aria-hidden />
      ) : (
        <Square className="mt-0.5 size-[1.05em] shrink-0 text-muted-foreground" aria-hidden />
      )
    ) : ordered ? (
      <span className="mt-px shrink-0 font-display text-[0.95em] font-semibold tabular-nums text-primary">
        {index + 1}.
      </span>
    ) : (
      <span aria-hidden className="mt-[0.5em] size-1.5 shrink-0 rounded-full bg-primary/60" />
    );

  return (
    <li className="flex gap-2.5">
      <span
        className={cn("flex shrink-0 justify-center", ordered ? "min-w-[1.4em]" : "w-[1.05em]")}
      >
        {marker}
      </span>
      <div className={cn("min-w-0 flex-1", item.checked ? "text-foreground/90" : undefined)}>
        <span className={cn(item.checked === true && "text-muted-foreground line-through")}>
          <Inlines nodes={item.inlines} />
        </span>
        {item.children.length > 0 && <Blocks blocks={item.children} className="mt-1.5" />}
      </div>
    </li>
  );
}

function Callout({
  variant,
  title,
  children,
}: {
  variant: CalloutVariant;
  title: InlineNode[] | null;
  children: ReactNode;
}) {
  const t = useT();
  const meta = calloutMeta(variant);
  const Icon = ICONS[meta.icon] ?? Info;
  const styles = roleStyles(meta.role);
  const collapsible = COLLAPSIBLE_CALLOUTS.has(variant);
  const [open, setOpen] = useState(false);
  const label = title ? <Inlines nodes={title} /> : t(meta.labelKey);

  return (
    <div
      className="my-4 rounded-xl border border-l-4 px-4 py-3 shadow-brand-sm"
      style={styles.wrap}
      role="note"
    >
      <div className="flex items-center gap-2" style={styles.accent}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="text-sm font-semibold">{label}</span>
        {collapsible && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="ml-auto rounded-md px-2 py-0.5 text-xs font-medium underline-offset-2 hover:underline"
          >
            {open ? t("material.answer.hide") : t("material.answer.show")}
          </button>
        )}
      </div>
      {(!collapsible || open) && (
        <div className="mt-1.5 text-[0.95em] leading-relaxed text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {children}
        </div>
      )}
    </div>
  );
}

function Block({ block }: { block: MaterialBlock }): ReactNode {
  switch (block.type) {
    case "heading": {
      const cls =
        block.level === 1
          ? "font-display text-h1 font-semibold leading-tight  text-foreground mt-8 mb-3 first:mt-0"
          : block.level === 2
            ? "font-display text-h2 font-semibold leading-snug  text-foreground mt-8 mb-3 first:mt-0 pb-1.5 border-b border-border/60"
            : "font-display text-h3 font-semibold leading-snug  text-foreground mt-6 mb-2 first:mt-0";
      const inner = <Inlines nodes={block.inlines} />;
      if (block.level === 1) return <h1 className={cls}>{inner}</h1>;
      if (block.level === 2) return <h2 className={cls}>{inner}</h2>;
      return <h3 className={cls}>{inner}</h3>;
    }
    case "paragraph":
      return (
        <p className="my-3 leading-[1.75] first:mt-0 last:mb-0">
          <Inlines nodes={block.inlines} />
        </p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className="my-3 space-y-1.5">
          {block.items.map((item, i) => (
            <ListItemRow key={i} item={item} ordered={block.ordered} index={i} />
          ))}
        </Tag>
      );
    }
    case "callout":
      return (
        <Callout variant={block.variant} title={block.title}>
          <Blocks blocks={block.blocks} />
        </Callout>
      );
    case "quote":
      return (
        <blockquote className="my-4 rounded-r-lg border-l-[3px] border-accent bg-accent/5 py-2 pl-4 pr-3 text-foreground/80">
          <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <Blocks blocks={block.blocks} />
          </div>
        </blockquote>
      );
    case "code":
      return (
        <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-muted/60 p-3.5 font-mono text-sm leading-relaxed text-foreground">
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <div className="my-4 overflow-x-auto rounded-xl border border-border shadow-brand-sm">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-muted">
                {block.header.map((cell, i) => (
                  <th
                    key={i}
                    className="border-b border-border px-3.5 py-2.5 font-display font-semibold text-foreground"
                    style={{ textAlign: block.align[i] ?? "left" }}
                  >
                    <Inlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="odd:bg-transparent even:bg-muted/30">
                  {block.header.map((_, ci) => (
                    <td
                      key={ci}
                      className="border-b border-border/60 px-3.5 py-2.5 leading-relaxed text-foreground/90"
                      style={{ textAlign: block.align[ci] ?? "left" }}
                    >
                      <Inlines nodes={row[ci] ?? []} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      return <MaterialImage src={block.src} alt={block.alt} />;
    case "timeline":
      return <MaterialTimeline block={block} />;
    case "divider":
      return <hr className="my-8 border-0 border-t border-border" />;
  }
}

/** A block image, with its alt doubling as a visible caption.
 *
 * A `src` outside the allow-list (see resolveMaterialImageSrc) is never
 * fetched — the alt renders as text instead, exactly as a disallowed link
 * href degrades to its label. That matters more for an image than for a link:
 * an <img> loads on render, with no click, so a bad src would reach out to
 * whatever host it names the moment a student opened the material.
 *
 * A plain <img>, not next/image: the stored-image route is an authenticated
 * redirect to a signed URL, which the Next image optimizer can neither
 * fetch (it has no session) nor usefully cache (the target rotates). */
function MaterialImage({ src, alt }: { src: string; alt: string }) {
  const ref = resolveMaterialImageSrc(src);
  if (!ref) {
    return alt ? <p className="my-3 text-sm text-muted-foreground">{alt}</p> : null;
  }
  const url = ref.kind === "stored" ? materialImageRoutePath(ref.key) : ref.url;

  return (
    <figure className="my-5">
      {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
      <img
        src={url}
        alt={alt}
        loading="lazy"
        decoding="async"
        // `referrerPolicy` only bites on the external-https case, where it
        // keeps the material's own URL out of a third-party host's logs.
        referrerPolicy="no-referrer"
        className="mx-auto max-h-[70vh] w-auto max-w-full rounded-xl border border-border bg-muted/30 object-contain"
      />
      {alt && (
        <figcaption className="mt-2 text-center text-sm text-muted-foreground">{alt}</figcaption>
      )}
    </figure>
  );
}

/** A tense timeline, drawn from the shared geometry (@spiralclass/shared's
 * `timelineGeometry`) — the same numbers mobile and the PDF draw from, so one
 * document can't become three different diagrams.
 *
 * The graphic is inline SVG built from DATA, never markup that arrived in the
 * body: the parser produces positions and plain-text labels and this component
 * decides every coordinate. That is the "no markup sink" boundary the visuals
 * design rests on (docs/architecture/material-visuals.md, D-17) — an
 * AI-authored `<svg>` would be an XSS sink and would not render on the other
 * two surfaces at all.
 *
 * Marker labels are HTML text under the graphic, not `<text>` inside it. None
 * of the three renderers can measure a string, so on-axis labels would collide
 * or overflow with no way to detect which; below it they wrap, translate and
 * get read aloud. The legend lists markers left-to-right in axis order, which
 * is what ties each caption to its marker. The SVG is therefore decorative and
 * hidden from assistive tech — all of its meaning is in the text beside it. */
function MaterialTimeline({ block }: { block: TimelineBlock }) {
  const geo = timelineGeometry(block);
  const legend = [
    ...(block.span?.label ? [{ kind: "span" as const, label: block.span.label }] : []),
    ...block.points.filter((p) => p.label).map((p) => ({ kind: "point" as const, label: p.label })),
  ];

  return (
    <figure className="my-5 rounded-xl border border-border bg-muted/20 px-4 py-3">
      <svg
        viewBox={`0 0 ${geo.width} ${geo.height}`}
        className="h-auto w-full"
        aria-hidden
        focusable="false"
      >
        {geo.span && (
          <rect
            x={geo.span.x}
            y={geo.span.y}
            width={geo.span.width}
            height={geo.span.height}
            rx={geo.span.radius}
            fill="hsl(var(--primary) / 0.2)"
            stroke="hsl(var(--primary))"
            strokeWidth={1}
          />
        )}
        <line
          x1={geo.axis.x1}
          y1={geo.axis.y1}
          x2={geo.axis.x2}
          y2={geo.axis.y2}
          stroke="hsl(var(--muted-foreground))"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
        <polygon points={geo.arrow} fill="hsl(var(--muted-foreground))" />
        <line
          x1={geo.now.x}
          y1={geo.now.y1}
          x2={geo.now.x}
          y2={geo.now.y2}
          stroke="hsl(var(--accent))"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        {geo.points.map((point, i) => (
          <circle
            key={i}
            cx={point.cx}
            cy={point.cy}
            r={point.r}
            fill="hsl(var(--primary))"
            stroke="hsl(var(--background))"
            strokeWidth={1.5}
          />
        ))}
      </svg>
      <div className="mt-1 flex text-xs text-muted-foreground">
        <span className="flex-1 text-left">{block.labels.past}</span>
        <span className="flex-1 text-center font-medium text-foreground">{block.labels.now}</span>
        <span className="flex-1 text-right">{block.labels.future}</span>
      </div>
      {legend.length > 0 && (
        <ul className="mt-2.5 space-y-1 text-sm text-foreground/90">
          {legend.map((entry, i) => (
            <li key={i} className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "shrink-0",
                  entry.kind === "span"
                    ? "h-2 w-5 rounded-full border border-primary bg-primary/20"
                    : "size-2 rounded-full bg-primary",
                )}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function Blocks({ blocks, className }: { blocks: MaterialBlock[]; className?: string }) {
  return (
    <div className={className}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

export type MaterialDocumentProps = {
  body: string;
  /** Constrain to a comfortable reading measure (single-column pages). Off for
   * narrow hosts like the in-call viewer or a card, which set their own width. */
  readingWidth?: boolean;
  className?: string;
};

/** Render a material `body` as a premium, brand-styled document. */
export function MaterialDocument({ body, readingWidth = false, className }: MaterialDocumentProps) {
  const doc = useMemo(() => parseMaterialDoc(body), [body]);
  return (
    <div
      className={cn(
        "material-document text-base text-foreground/90",
        readingWidth && "mx-auto max-w-[70ch]",
        className,
      )}
    >
      <Blocks blocks={doc.blocks} />
    </div>
  );
}
