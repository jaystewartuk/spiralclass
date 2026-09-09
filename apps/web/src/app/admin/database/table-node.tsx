"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ChevronDown, ChevronRight, KeyRound, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/components/locale-provider";
import type { ErdTable } from "@/lib/erd/types";
import { NODE_WIDTH } from "@/lib/erd/layout";

export type TableNodeData = {
  table: ErdTable;
  expanded: boolean;
  /** "primary" = the focused table, "connected" = a direct FK neighbour. */
  highlight: "primary" | "connected" | null;
  dimmed: boolean;
  matched: boolean;
  onToggleExpand: (id: string) => void;
};

export type TableNode = Node<TableNodeData, "table">;

// A handle on each horizontal side, both source and target, all invisible. The
// viewer picks which pair an edge uses based on the ELK-decided left/right
// ordering, so foreign keys always route cleanly between adjacent tables.
const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, border: "none", minWidth: 0, minHeight: 0 };

function TableNodeComponent({ data, selected }: NodeProps<TableNode>) {
  const t = useT();
  const { table, expanded, highlight, dimmed, matched, onToggleExpand } = data;

  return (
    <div
      style={{ width: NODE_WIDTH }}
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-sm transition-[opacity,box-shadow,border-color]",
        dimmed ? "opacity-35" : "opacity-100",
        highlight === "primary" || selected
          ? "border-primary ring-2 ring-primary/50"
          : highlight === "connected"
            ? "border-info ring-1 ring-info/40"
            : matched
              ? "border-warning ring-1 ring-warning/50"
              : "border-border",
      )}
    >
      <Handle id="l-target" type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="l-source" type="source" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="r-target" type="target" position={Position.Right} style={HANDLE_STYLE} />
      <Handle id="r-source" type="source" position={Position.Right} style={HANDLE_STYLE} />

      {/* Header — clicking toggles the column body. A button so it's keyboard
          reachable; the whole node is still selectable via React Flow. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand(table.id);
        }}
        className={cn(
          "flex w-full items-center gap-2 rounded-t-lg px-3 py-2.5 text-left",
          "bg-muted/60 hover:bg-muted",
        )}
        aria-expanded={expanded}
        aria-label={
          expanded
            ? t("web.admin.erd.node.collapse", { table: table.name })
            : t("web.admin.erd.node.expand", { table: table.name })
        }
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">
          {table.name}
        </span>
        <span className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 text-sm font-medium text-muted-foreground">
          {table.columns.length}
        </span>
      </button>

      {expanded ? (
        <ul className="space-y-0 py-1">
          {table.columns.map((col) => (
            <li
              key={col.name}
              className="flex items-center gap-2 px-3 py-1 font-mono text-xs leading-none"
            >
              <span className="flex w-4 shrink-0 justify-center">
                {col.isPrimaryKey ? (
                  <KeyRound
                    className="h-3.5 w-3.5 text-warning"
                    aria-label={t("web.admin.erd.legend.pk")}
                  />
                ) : col.isForeignKey ? (
                  <Link2
                    className="h-3.5 w-3.5 text-info"
                    aria-label={t("web.admin.erd.legend.fk")}
                  />
                ) : null}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  col.isPrimaryKey ? "font-semibold" : "font-normal",
                )}
              >
                {col.name}
                {col.isNotNull || col.isPrimaryKey ? (
                  <span className="text-destructive" aria-hidden>
                    {" "}
                    *
                  </span>
                ) : null}
              </span>
              {col.isUnique ? (
                <span
                  className="shrink-0 rounded bg-success-bg px-1 text-sm font-semibold text-success"
                  title={t("web.admin.erd.legend.unique")}
                >
                  {t("web.admin.erd.badge.unique")}
                </span>
              ) : null}
              <span className="max-w-[45%] shrink-0 truncate text-muted-foreground">
                {col.type}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex items-center justify-between px-3 py-2 text-sm text-muted-foreground">
          <span>{t("web.admin.erd.node.columnCount", { count: table.columns.length })}</span>
          {table.indexes.length > 0 ? (
            <span>{t("web.admin.erd.node.indexCount", { count: table.indexes.length })}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export const TableNodeView = memo(TableNodeComponent);
