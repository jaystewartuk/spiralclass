import { requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { getT } from "@/lib/i18n";
import type { ErdSchemaGraph } from "@/lib/erd/types";
import graphJson from "@/lib/erd/schema.generated.json";
import { ErdViewer } from "./erd-viewer";

// Interactive database ERD. The diagram is driven entirely by the generated
// schema graph (src/lib/erd/schema.generated.json), which is produced from the
// canonical DBML at build time — see docs/architecture/ERD.md. Nothing here
// touches the live database or parses DBML at runtime.
//
// Gated to superadmin, with the `schema:view` capability as the alternate path
// so the narrow `engineer` role (D-55) can reach it without inheriting the rest
// of the superadmin surface.
export const metadata = { title: "Database ERD" };

// The JSON is generated to match ErdSchemaGraph exactly (drift-guarded by
// tests/erd-schema.test.ts); the double cast bridges the wide inferred JSON
// type (string, not the literal cardinality union) to the contract.
const graph = graphJson as unknown as ErdSchemaGraph;

export default async function AdminDatabaseErdPage() {
  await requireAdmin("superadmin", "schema:view");
  const t = await getT();

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="shrink-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <PageHeader title={t("web.admin.erd.title")} />
          <p className="text-muted-foreground text-sm">
            {t("web.admin.erd.stats", {
              tables: graph.tables.length,
              relationships: graph.relationships.length,
            })}
          </p>
        </div>
        <p className="text-muted-foreground text-sm">{t("web.admin.erd.subtitle")}</p>
      </header>

      {/* The canvas needs a bounded height to fill; the admin main scroll area
          is the parent, so pin it to the remaining viewport. */}
      <div className="border-border/60 min-h-0 flex-1 overflow-hidden rounded-lg border">
        <ErdViewer graph={graph} />
      </div>
    </div>
  );
}
