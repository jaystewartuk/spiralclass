"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/components/locale-provider";

// Sort control for the materials library. Writes `?sort=` and resets `?page=`
// (a new order invalidates the old page window), then lets the server re-render
// the ordered, paginated list. "recent" is the canonical default and stays out
// of the URL.
export function MaterialsSort() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const t = useT();
  const current = params.get("sort") ?? "recent";

  function onChange(next: string) {
    const p = new URLSearchParams(params.toString());
    if (next === "recent") p.delete("sort");
    else p.set("sort", next);
    p.delete("page");
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <Select value={current} onValueChange={onChange}>
      <SelectTrigger className="w-full lg:w-44" aria-label={t("web.materials.sortLabel")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="recent">{t("web.materials.sortRecent")}</SelectItem>
        <SelectItem value="oldest">{t("web.materials.sortOldest")}</SelectItem>
        <SelectItem value="name">{t("web.materials.sortName")}</SelectItem>
      </SelectContent>
    </Select>
  );
}
