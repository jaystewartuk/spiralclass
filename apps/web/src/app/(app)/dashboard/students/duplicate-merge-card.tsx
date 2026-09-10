"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { mergeRosterStudents } from "@/app/actions/students-merge";
import type { OverrideState } from "@/app/actions/overrides";
import type { DuplicateReason } from "@/lib/students/duplicates";
import { useT } from "@/components/locale-provider";
import type { TFunction } from "@/lib/i18n-translate";

// Roster hygiene hint: pairs detected by lib/students/duplicates.ts (same
// email / same phone / near-identical email — usually a checkout typo).
// The server pre-picks which row survives (login > more packages > older);
// the teacher just confirms. The action re-validates everything.

export interface DuplicateSide {
  id: string;
  name: string;
  email: string | null;
  hasLogin: boolean;
  packageCount: number;
}

export interface DuplicatePairDisplay {
  keep: DuplicateSide;
  merge: DuplicateSide;
  reason: DuplicateReason;
}

export function DuplicateMergeCard({ pairs }: { pairs: DuplicatePairDisplay[] }) {
  const t = useT();
  if (pairs.length === 0) return null;

  return (
    <section className="border-warning/40 bg-warning-bg space-y-3 rounded-md border p-4">
      <div>
        <h2 className="text-warning text-sm font-semibold">
          {pairs.length === 1
            ? t("web.dashboard.students.duplicate.titleOne")
            : t("web.dashboard.students.duplicate.titleMany")}
        </h2>
        <p className="text-warning text-xs">{t("web.dashboard.students.duplicate.body")}</p>
      </div>
      <ul className="space-y-3">
        {pairs.map((pair) => (
          <DuplicatePairRow key={`${pair.keep.id}-${pair.merge.id}`} pair={pair} t={t} />
        ))}
      </ul>
    </section>
  );
}

function reasonCopy(reason: DuplicateReason, t: TFunction): string {
  switch (reason) {
    case "same_email":
      return t("web.dashboard.students.duplicate.reason.sameEmail");
    case "same_phone":
      return t("web.dashboard.students.duplicate.reason.samePhone");
    case "similar_email":
      return t("web.dashboard.students.duplicate.reason.similarEmail");
  }
}

function DuplicatePairRow({ pair, t }: { pair: DuplicatePairDisplay; t: TFunction }) {
  const [state, formAction, pending] = useActionState<OverrideState, FormData>(
    mergeRosterStudents,
    undefined,
  );

  const side = (s: DuplicateSide, kept: boolean) => (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium">
        {s.name}
        {kept && (
          <Badge variant="success" className="ml-1.5">
            {t("web.dashboard.students.duplicate.kept")}
          </Badge>
        )}
      </div>
      <div className="text-muted-foreground truncate text-xs">
        {s.email ?? t("web.dashboard.students.noEmail")}
      </div>
      <div className="text-muted-foreground text-sm">
        {t("web.dashboard.students.duplicate.packageCount", { count: s.packageCount })}
        {s.hasLogin && <> · {t("web.dashboard.students.duplicate.hasSignedIn")}</>}
      </div>
    </div>
  );

  return (
    <li className="border-warning/30 bg-card rounded-md border p-3">
      <div className="text-muted-foreground mb-2 text-sm">{reasonCopy(pair.reason, t)}</div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        {side(pair.keep, true)}
        {side(pair.merge, false)}
        <form
          action={formAction}
          onSubmit={(e) => {
            const message = t("web.dashboard.students.duplicate.confirm", {
              mergeName: pair.merge.email ?? pair.merge.name,
              keepName: pair.keep.email ?? pair.keep.name,
            });
            if (!confirm(message)) e.preventDefault();
          }}
        >
          <input type="hidden" name="keepStudentId" value={pair.keep.id} />
          <input type="hidden" name="mergeStudentId" value={pair.merge.id} />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? "..." : t("web.dashboard.students.duplicate.merge")}
          </Button>
        </form>
      </div>
      {state?.error && (
        <p role="alert" className="text-destructive mt-2 text-xs">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="text-success mt-2 text-xs">
          {state.ok}
        </p>
      )}
    </li>
  );
}
