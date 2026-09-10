"use client";

import "@xyflow/react/dist/style.css";
import "./erd.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeMouseHandler,
  type NodeMouseHandler,
} from "@xyflow/react";
import { Maximize2, Rows3, Search, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import type { ErdRelationship, ErdSchemaGraph } from "@/lib/erd/types";
import { computeLayout, type LayoutPosition } from "@/lib/erd/layout";
import { TableNodeView, type TableNode } from "./table-node";
import { DetailsPanel, type Selection } from "./details-panel";

const nodeTypes = { table: TableNodeView };

function relKey(r: ErdRelationship): string {
  return r.id;
}

function ErdFlow({ graph }: { graph: ErdSchemaGraph }) {
  const t = useT();
  const { resolvedTheme } = useTheme();
  const { fitView } = useReactFlow<TableNode>();

  const [nodes, setNodes, onNodesChange] = useNodesState<TableNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");

  const tableById = useMemo(() => new Map(graph.tables.map((t) => [t.id, t])), [graph.tables]);
  const relById = useMemo(
    () => new Map(graph.relationships.map((r) => [relKey(r), r])),
    [graph.relationships],
  );

  // Tables directly linked to a given table by a foreign key (either direction).
  const neighboursOf = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of graph.relationships) {
      if (!map.has(r.source.table)) map.set(r.source.table, new Set());
      if (!map.has(r.target.table)) map.set(r.target.table, new Set());
      map.get(r.source.table)!.add(r.target.table);
      map.get(r.target.table)!.add(r.source.table);
    }
    return map;
  }, [graph.relationships]);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set(graph.tables.filter((t) => t.name.toLowerCase().includes(q)).map((t) => t.id));
  }, [query, graph.tables]);

  const onToggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // (Re)compute layout whenever node heights change (expand/collapse) or the
  // graph itself changes. Positions are kept in a ref so the view-state effect
  // below can rebuild node data without clobbering a manual drag.
  useEffect(() => {
    let cancelled = false;
    computeLayout(graph.tables, graph.relationships, expanded).then((positions) => {
      if (cancelled) return;
      setNodes(
        graph.tables.map((table) => ({
          id: table.id,
          type: "table" as const,
          position: positions.get(table.id) ?? { x: 0, y: 0 },
          data: {
            table,
            expanded: expanded.has(table.id),
            highlight: null,
            dimmed: false,
            matched: false,
            onToggleExpand,
          },
        })),
      );
      setEdges(buildEdges(graph.relationships, positions));
      requestAnimationFrame(() => fitView({ padding: 0.2, duration: 400 }));
    });
    return () => {
      cancelled = true;
    };
  }, [graph, expanded, onToggleExpand, fitView, setNodes, setEdges]);

  // Refresh node/edge *view state* (highlight, dimming, search match) without a
  // relayout — cheap, and preserves any manual drag.
  useEffect(() => {
    const neighbours = selectedTableId
      ? (neighboursOf.get(selectedTableId) ?? new Set<string>())
      : null;
    const searching = matched.size > 0;

    setNodes((prev) =>
      prev.map((node) => {
        const isPrimary = node.id === selectedTableId;
        const isConnected = neighbours?.has(node.id) ?? false;
        const isMatch = matched.has(node.id);
        const dimmed =
          (selectedTableId != null && !isPrimary && !isConnected) ||
          (searching && !isMatch && selectedTableId == null);
        return {
          ...node,
          data: {
            ...node.data,
            expanded: expanded.has(node.id),
            highlight: isPrimary ? "primary" : isConnected ? "connected" : null,
            matched: isMatch && !isPrimary,
            dimmed,
          },
        };
      }),
    );

    setEdges((prev) =>
      prev.map((edge) => {
        const touches = edge.source === selectedTableId || edge.target === selectedTableId;
        const active = selectedTableId == null || touches;
        return {
          ...edge,
          animated: touches && selectedTableId != null,
          style: {
            ...edge.style,
            stroke: touches ? "hsl(var(--primary))" : "hsl(var(--muted-foreground) / 0.45)",
            strokeWidth: touches ? 2 : 1.4,
            opacity: active ? 1 : 0.12,
          },
        };
      }),
    );
  }, [selectedTableId, matched, expanded, neighboursOf, setNodes, setEdges]);

  const onNodeClick = useCallback<NodeMouseHandler<TableNode>>(
    (_e, node) => {
      setSelectedTableId(node.id);
      const table = tableById.get(node.id);
      if (table) setSelection({ kind: "table", table });
    },
    [tableById],
  );

  const onEdgeClick = useCallback<EdgeMouseHandler<Edge>>(
    (_e, edge) => {
      const rel = edge.data?.relKey ? relById.get(edge.data.relKey as string) : null;
      if (rel) {
        setSelection({ kind: "relationship", relationship: rel });
        setSelectedTableId(rel.source.table);
      }
    },
    [relById],
  );

  const clearSelection = useCallback(() => {
    setSelectedTableId(null);
    setSelection(null);
  }, []);

  const selectTableById = useCallback(
    (id: string) => {
      const table = tableById.get(id);
      if (!table) return;
      setSelectedTableId(id);
      setSelection({ kind: "table", table });
      fitView({ padding: 0.6, duration: 400, nodes: [{ id }] });
    },
    [tableById, fitView],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection]);

  const runSearch = useCallback(() => {
    if (matched.size === 0) return;
    fitView({ padding: 0.3, duration: 400, nodes: [...matched].map((id) => ({ id })) });
  }, [matched, fitView]);

  return (
    <div className="relative h-full w-full">
      <ReactFlow<TableNode>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={clearSelection}
        nodeTypes={nodeTypes}
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "smoothstep" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          ariaLabel={t("web.admin.erd.minimap")}
          nodeColor={(n) => {
            const data = n.data as TableNode["data"] | undefined;
            if (data?.highlight === "primary") return "hsl(var(--primary))";
            if (data?.highlight === "connected") return "hsl(var(--info))";
            if (data?.matched) return "hsl(var(--warning))";
            return "hsl(var(--muted-foreground) / 0.5)";
          }}
          maskColor="hsl(var(--background) / 0.6)"
        />

        <Panel position="top-left" className="!m-3 w-64">
          <div className="rounded-lg border border-border/60 bg-background/95 p-2 shadow-xs backdrop-blur">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
                placeholder={t("web.admin.erd.searchPlaceholder")}
                aria-label={t("web.admin.erd.searchAria")}
                className="h-9 w-full rounded-md border border-input bg-background pr-8 pl-8 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("web.admin.erd.searchClear")}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            {query && matched.size > 0 ? (
              <p className="mt-1 px-1 text-sm text-muted-foreground">
                {t("web.admin.erd.searchResults", { count: matched.size })}
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel position="top-right" className="!m-3">
          <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-background/95 p-1 shadow-xs backdrop-blur">
            <ToolbarButton
              label={t("web.admin.erd.fit")}
              onClick={() => fitView({ padding: 0.2, duration: 400 })}
            >
              <Maximize2 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton
              label={t("web.admin.erd.expandAll")}
              onClick={() => setExpanded(new Set(graph.tables.map((tb) => tb.id)))}
            >
              <Rows3 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton
              label={t("web.admin.erd.collapseAll")}
              onClick={() => setExpanded(new Set())}
            >
              <Rows3 className="h-4 w-4 rotate-90" />
            </ToolbarButton>
          </div>
        </Panel>

        <Panel position="bottom-center" className="!mb-4">
          <Legend />
        </Panel>
      </ReactFlow>

      {selection ? (
        <DetailsPanel
          selection={selection}
          relationships={graph.relationships}
          onClose={clearSelection}
          onSelectTable={selectTableById}
        />
      ) : null}
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Legend() {
  const t = useT();
  const items = [
    { className: "bg-warning", label: t("web.admin.erd.legend.pk") },
    { className: "bg-info", label: t("web.admin.erd.legend.fk") },
    { className: "bg-success", label: t("web.admin.erd.legend.unique") },
  ];
  return (
    <div className="flex items-center gap-3 rounded-full border border-border/60 bg-background/95 px-3 py-1.5 text-sm text-muted-foreground shadow-xs backdrop-blur">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", item.className)} aria-hidden />
          {item.label}
        </span>
      ))}
    </div>
  );
}

// Choose which side handles an edge attaches to from the ELK-decided left/right
// ordering, so foreign keys route cleanly between adjacent layers.
function buildEdges(
  relationships: ErdRelationship[],
  positions: Map<string, LayoutPosition>,
): Edge[] {
  return relationships.map((rel) => {
    const sx = positions.get(rel.source.table)?.x ?? 0;
    const tx = positions.get(rel.target.table)?.x ?? 0;
    const sourceRight = sx <= tx;
    return {
      id: relKey(rel),
      source: rel.source.table,
      target: rel.target.table,
      sourceHandle: sourceRight ? "r-source" : "l-source",
      targetHandle: sourceRight ? "l-target" : "r-target",
      type: "smoothstep",
      data: { relKey: relKey(rel) },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: {
        stroke: "hsl(var(--muted-foreground) / 0.45)",
        strokeWidth: 1.4,
      },
    } satisfies Edge;
  });
}

export function ErdViewer({ graph }: { graph: ErdSchemaGraph }) {
  const t = useT();
  if (graph.tables.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-sm text-muted-foreground">
        {t("web.admin.erd.empty")}
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <ErdFlow graph={graph} />
    </ReactFlowProvider>
  );
}
