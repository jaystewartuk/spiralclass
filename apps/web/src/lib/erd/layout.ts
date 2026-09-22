import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { ErdRelationship, ErdTable } from "./types";

// Automatic ERD layout via ELK's layered algorithm — the standard choice for
// directed database diagrams (foreign keys flow in one direction, tables settle
// into tidy layers). Runs client-side; elk.bundled.js has no worker/CDN
// dependency so it works under the app's strict CSP.

const elk = new ELK();

export const NODE_WIDTH = 288;
export const HEADER_HEIGHT = 44;
export const COLLAPSED_SUMMARY_HEIGHT = 34;
export const COLUMN_ROW_HEIGHT = 26;
export const BODY_PADDING = 8;

/** Rendered height of a table node given whether its columns are expanded. */
export function nodeHeight(table: ErdTable, expanded: boolean): number {
  if (!expanded) return HEADER_HEIGHT + COLLAPSED_SUMMARY_HEIGHT;
  return HEADER_HEIGHT + BODY_PADDING * 2 + table.columns.length * COLUMN_ROW_HEIGHT;
}

export interface LayoutPosition {
  x: number;
  y: number;
}

const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.nodeNode": "48",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.mergeEdges": "true",
  "elk.edgeRouting": "SPLINES",
};

/**
 * Compute node positions for the graph. Pure over its inputs; returns a map of
 * table id → {x, y}. Re-run whenever the set of expanded tables changes (node
 * heights change, so the layout must be recomputed).
 */
export async function computeLayout(
  tables: ErdTable[],
  relationships: ErdRelationship[],
  expanded: Set<string>,
): Promise<Map<string, LayoutPosition>> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: tables.map((table) => ({
      id: table.id,
      width: NODE_WIDTH,
      height: nodeHeight(table, expanded.has(table.id)),
    })),
    edges: relationships.map((rel, i) => ({
      id: `e${i}`,
      sources: [rel.source.table],
      targets: [rel.target.table],
    })),
  };

  const result = await elk.layout(graph);
  const positions = new Map<string, LayoutPosition>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}
