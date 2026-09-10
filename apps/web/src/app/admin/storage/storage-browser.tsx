"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { ChevronRight, Folder, File, ExternalLink, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableShell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useT } from "@/components/locale-provider";
import { listStorageAction, signStorageObjectAction } from "@/app/actions/admin-storage";
import type { StorageObject } from "@/lib/storage/r2-admin";

type BucketInfo = {
  key: string;
  label: string;
  sensitivity: "public" | "private" | "sensitive";
  description: string;
};

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// Last path segment of a "folder" prefix ("a/b/" -> "b").
function prefixLeaf(prefix: string): string {
  return prefix.replace(/\/$/, "").split("/").pop() ?? prefix;
}

// Object key display: strip the current prefix so only the leaf shows.
function objectLeaf(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function StorageBrowser({ buckets }: { buckets: BucketInfo[] }) {
  const t = useT();
  const SENSITIVITY_BADGE: Record<
    BucketInfo["sensitivity"],
    { label: string; variant: "info" | "warning" | "destructive" }
  > = {
    public: { label: t("web.admin.storage.sensitivity.public"), variant: "info" },
    private: { label: t("web.admin.storage.sensitivity.private"), variant: "warning" },
    sensitive: { label: t("web.admin.storage.sensitivity.sensitive"), variant: "destructive" },
  };
  const [bucketKey, setBucketKey] = useState(buckets[0]?.key ?? "");
  const [prefix, setPrefix] = useState("");
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const bucket = buckets.find((b) => b.key === bucketKey) ?? buckets[0];

  // Load a fresh listing (append=false) or the next page (append=true).
  const load = useCallback((bKey: string, pfx: string, token: string | null, append: boolean) => {
    startTransition(async () => {
      const res = await listStorageAction(bKey, pfx, token ?? undefined);
      if ("error" in res) {
        setError(res.error);
        if (!append) {
          setPrefixes([]);
          setObjects([]);
          setNextToken(null);
        }
        return;
      }
      setError(null);
      setPrefixes((prev) => (append ? [...prev, ...res.listing.prefixes] : res.listing.prefixes));
      setObjects((prev) => (append ? [...prev, ...res.listing.objects] : res.listing.objects));
      setNextToken(res.listing.nextToken);
    });
  }, []);

  // Reload whenever the bucket or prefix changes.
  useEffect(() => {
    if (!bucketKey) return;
    load(bucketKey, prefix, null, false);
  }, [bucketKey, prefix, load]);

  const openObject = (key: string) => {
    startTransition(async () => {
      const res = await signStorageObjectAction(bucketKey, key);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      window.open(res.url, "_blank", "noopener,noreferrer");
    });
  };

  const changeBucket = (key: string) => {
    setBucketKey(key);
    setPrefix("");
  };

  // Breadcrumb segments derived from the prefix ("a/b/" -> [a, b]).
  const segments = prefix ? prefix.replace(/\/$/, "").split("/") : [];
  const crumbTo = (i: number) => segments.slice(0, i + 1).join("/") + "/";

  return (
    <div className="space-y-4">
      {/* Bucket picker */}
      <div className="flex flex-wrap gap-2">
        {buckets.map((b) => {
          const active = b.key === bucketKey;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => changeBucket(b.key)}
              aria-pressed={active}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                active
                  ? "border-primary bg-primary/10 font-medium text-foreground"
                  : "border-border/60 text-muted-foreground hover:bg-muted/60",
              )}
            >
              {b.label}
            </button>
          );
        })}
      </div>

      {bucket && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant={SENSITIVITY_BADGE[bucket.sensitivity].variant}>
                  {SENSITIVITY_BADGE[bucket.sensitivity].label}
                </Badge>
                <span className="text-sm text-muted-foreground">{bucket.description}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => load(bucketKey, prefix, null, false)}
                disabled={pending}
              >
                <RotateCcw className="h-3.5 w-3.5" /> {t("web.admin.storage.refresh")}
              </Button>
            </div>

            {/* Breadcrumb */}
            <nav
              aria-label={t("web.admin.storage.pathLabel")}
              className="flex flex-wrap items-center gap-1 text-sm"
            >
              <button
                type="button"
                onClick={() => setPrefix("")}
                className="rounded px-1.5 py-0.5 font-medium hover:bg-muted/60"
              >
                {bucket.label}
              </button>
              {segments.map((seg, i) => (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <button
                    type="button"
                    onClick={() => setPrefix(crumbTo(i))}
                    className="rounded px-1.5 py-0.5 hover:bg-muted/60"
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </nav>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive-bg px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <TableShell>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("web.admin.storage.colName")}</TableHead>
                    <TableHead className="text-right">{t("web.admin.storage.colSize")}</TableHead>
                    <TableHead className="text-right">
                      {t("web.admin.storage.colModified")}
                    </TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {prefixes.length === 0 && objects.length === 0 && !pending && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-sm text-muted-foreground">
                        {t("web.admin.storage.empty")}
                      </TableCell>
                    </TableRow>
                  )}

                  {prefixes.map((p) => (
                    <TableRow
                      key={`p:${p}`}
                      className="cursor-pointer"
                      onClick={() => setPrefix(p)}
                    >
                      <TableCell className="font-medium">
                        <span className="inline-flex items-center gap-2">
                          <Folder className="h-4 w-4 text-muted-foreground" />
                          {prefixLeaf(p)}/
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">—</TableCell>
                      <TableCell className="text-right text-muted-foreground">—</TableCell>
                      <TableCell />
                    </TableRow>
                  ))}

                  {objects.map((o) => (
                    <TableRow key={`o:${o.key}`}>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          <File className="h-4 w-4 text-muted-foreground" />
                          <span className="font-mono text-xs">{objectLeaf(o.key, prefix)}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {humanSize(o.size)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {o.lastModified ? new Date(o.lastModified).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openObject(o.key)}
                          disabled={pending}
                          aria-label={t("web.admin.storage.openObject", { key: o.key })}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableShell>

            {nextToken && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => load(bucketKey, prefix, nextToken, true)}
                  disabled={pending}
                >
                  {t("web.admin.storage.loadMore")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
