import { requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { listBrowsableBuckets } from "@/lib/storage/r2-admin";
import { getT } from "@/lib/i18n";
import { StorageBrowser } from "./storage-browser";

// Superadmin R2 object browser. Read-only, audited, and scoped to an ALLOWLIST
// of this product's own content buckets (lib/storage/r2-admin.ts) — deliberately
// NOT a generic "every bucket the Cloudflare account can see" view. Full DB
// backups, OpenTofu state, and other products' buckets are intentionally absent;
// they live behind the Cloudflare dashboard under separate credentials. Opening
// any object mints a short-lived signed URL and writes an audit row.
export default async function AdminStoragePage() {
  await requireAdmin("superadmin");
  const t = await getT();

  const buckets = listBrowsableBuckets();

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.storage.title")} />
        <p className="text-muted-foreground text-sm">
          {t("web.admin.storage.intro.pre")}{" "}
          <a href="/admin/audit" className="underline underline-offset-2">
            {t("web.admin.storage.auditLog")}
          </a>
          {t("web.admin.storage.intro.post")}
        </p>
      </header>

      {buckets.length === 0 ? (
        <div className="border-border/60 bg-muted/40 text-muted-foreground rounded-lg border px-4 py-6 text-sm">
          {t("web.admin.storage.noBuckets")}
        </div>
      ) : (
        <StorageBrowser buckets={buckets} />
      )}
    </div>
  );
}
