"use client";

import Link from "next/link";
import { ExternalLink, KeyRound, Link2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useT } from "@/components/locale-provider";
import { adminRouteForTable } from "@/lib/erd/admin-routes";
import type { ErdRelationship, ErdTable } from "@/lib/erd/types";

export type Selection =
  { kind: "table"; table: ErdTable } | { kind: "relationship"; relationship: ErdRelationship };

const CARDINALITY_KEY = {
  "one-to-one": "web.admin.erd.cardinality.oneToOne",
  "one-to-many": "web.admin.erd.cardinality.oneToMany",
  "many-to-one": "web.admin.erd.cardinality.manyToOne",
  "many-to-many": "web.admin.erd.cardinality.manyToMany",
} as const;

function tableName(id: string): string {
  return id.includes(".") ? id.slice(id.indexOf(".") + 1) : id;
}

export function DetailsPanel({
  selection,
  relationships,
  onClose,
  onSelectTable,
}: {
  selection: Selection;
  relationships: ErdRelationship[];
  onClose: () => void;
  onSelectTable: (tableId: string) => void;
}) {
  const t = useT();

  return (
    <aside className="max-w-sheet border-border/60 bg-background/95 absolute top-0 right-0 z-10 flex h-full w-80 flex-col border-l shadow-xl backdrop-blur">
      <header className="border-border/60 flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="text-subtle text-sm font-semibold">
            {selection.kind === "table"
              ? t("web.admin.erd.panel.tableHeading")
              : t("web.admin.erd.panel.relationshipHeading")}
          </p>
          <h2 className="truncate font-mono text-sm font-semibold">
            {selection.kind === "table"
              ? selection.table.name
              : `${tableName(selection.relationship.source.table)} → ${tableName(selection.relationship.target.table)}`}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("web.admin.erd.panel.close")}
          className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
        {selection.kind === "table" ? (
          <TableDetails
            table={selection.table}
            relationships={relationships}
            onSelectTable={onSelectTable}
          />
        ) : (
          <RelationshipDetails
            relationship={selection.relationship}
            onSelectTable={onSelectTable}
          />
        )}
      </div>
    </aside>
  );
}

function TableDetails({
  table,
  relationships,
  onSelectTable,
}: {
  table: ErdTable;
  relationships: ErdRelationship[];
  onSelectTable: (tableId: string) => void;
}) {
  const t = useT();
  const adminRoute = adminRouteForTable(table.name);
  const outgoing = relationships.filter((r) => r.source.table === table.id);
  const incoming = relationships.filter((r) => r.target.table === table.id);

  return (
    <div className="space-y-5">
      {table.note ? <p className="text-muted-foreground text-xs">{table.note}</p> : null}

      {adminRoute ? (
        <Link
          href={adminRoute}
          className="border-border hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("web.admin.erd.panel.openInAdmin")}
        </Link>
      ) : null}

      <Section title={t("web.admin.erd.panel.columns")} count={table.columns.length}>
        <ul className="space-y-1">
          {table.columns.map((col) => (
            <li key={col.name} className="flex items-center gap-2 font-mono text-xs">
              <span className="flex w-4 shrink-0 justify-center">
                {col.isPrimaryKey ? (
                  <KeyRound className="text-warning h-3.5 w-3.5" />
                ) : col.isForeignKey ? (
                  <Link2 className="text-info h-3.5 w-3.5" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{col.name}</span>
              <span className="text-muted-foreground shrink-0 truncate">{col.type}</span>
            </li>
          ))}
        </ul>
      </Section>

      {table.indexes.length > 0 ? (
        <Section title={t("web.admin.erd.panel.indexes")} count={table.indexes.length}>
          <ul className="space-y-1.5">
            {table.indexes.map((idx, i) => (
              <li key={idx.name ?? i} className="font-mono text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  {idx.isPrimaryKey ? (
                    <Badge
                      variant="warning"
                      className="px-1 py-0 text-sm"
                      title={t("web.admin.erd.legend.pk")}
                    >
                      {t("web.admin.erd.badge.pk")}
                    </Badge>
                  ) : null}
                  {idx.isUnique ? (
                    <Badge
                      variant="success"
                      className="px-1 py-0 text-sm"
                      title={t("web.admin.erd.legend.unique")}
                    >
                      {t("web.admin.erd.badge.unique")}
                    </Badge>
                  ) : null}
                  <span className="text-muted-foreground">({idx.columns.join(", ")})</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {outgoing.length > 0 ? (
        <Section title={t("web.admin.erd.panel.references")} count={outgoing.length}>
          <RelationshipList rels={outgoing} pick="target" onSelectTable={onSelectTable} />
        </Section>
      ) : null}

      {incoming.length > 0 ? (
        <Section title={t("web.admin.erd.panel.referencedBy")} count={incoming.length}>
          <RelationshipList rels={incoming} pick="source" onSelectTable={onSelectTable} />
        </Section>
      ) : null}
    </div>
  );
}

function RelationshipList({
  rels,
  pick,
  onSelectTable,
}: {
  rels: ErdRelationship[];
  pick: "source" | "target";
  onSelectTable: (tableId: string) => void;
}) {
  return (
    <ul className="space-y-1">
      {rels.map((r) => {
        const other = r[pick];
        const own = pick === "target" ? r.source : r.target;
        return (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelectTable(other.table)}
              className="hover:bg-muted flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-xs"
            >
              <span className="text-muted-foreground truncate">{own.columns.join(", ")}</span>
              <span aria-hidden>→</span>
              <span className="min-w-0 flex-1 truncate font-medium">{tableName(other.table)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function RelationshipDetails({
  relationship,
  onSelectTable,
}: {
  relationship: ErdRelationship;
  onSelectTable: (tableId: string) => void;
}) {
  const t = useT();
  const rows: Array<{ label: string; value: string }> = [
    {
      label: t("web.admin.erd.rel.cardinality"),
      value: t(CARDINALITY_KEY[relationship.cardinality]),
    },
  ];
  if (relationship.onDelete)
    rows.push({ label: t("web.admin.erd.rel.onDelete"), value: relationship.onDelete });
  if (relationship.onUpdate)
    rows.push({ label: t("web.admin.erd.rel.onUpdate"), value: relationship.onUpdate });

  return (
    <div className="space-y-5">
      <div className="border-border/60 bg-muted/40 rounded-md border p-3 font-mono text-xs">
        <EndpointRow
          label={t("web.admin.erd.rel.from")}
          endpoint={relationship.source}
          onSelectTable={onSelectTable}
        />
        <div className="text-muted-foreground my-1 pl-1" aria-hidden>
          ↓
        </div>
        <EndpointRow
          label={t("web.admin.erd.rel.to")}
          endpoint={relationship.target}
          onSelectTable={onSelectTable}
        />
      </div>

      <dl className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground text-xs">{row.label}</dt>
            <dd className="font-mono text-xs font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EndpointRow({
  label,
  endpoint,
  onSelectTable,
}: {
  label: string;
  endpoint: { table: string; columns: string[] };
  onSelectTable: (tableId: string) => void;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-subtle w-10 shrink-0 text-sm">{label}</span>
      <button
        type="button"
        onClick={() => onSelectTable(endpoint.table)}
        className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
      >
        {tableName(endpoint.table)}
        <span className="text-muted-foreground">.{endpoint.columns.join(", ")}</span>
      </button>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className={cn("text-subtle mb-2 text-sm font-semibold")}>
        {title}
        {count != null ? <span className="text-muted-foreground/50 ml-1">({count})</span> : null}
      </h3>
      {children}
    </section>
  );
}
