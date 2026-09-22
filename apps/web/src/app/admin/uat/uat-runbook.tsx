"use client";

import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  runUatProbeAction,
  runPostHogCheckAction,
  runStripeCheckAction,
  reseedPreviewAction,
  getReseedStatusAction,
  toggleUatChecklistItemAction,
  clearUatChecklistAction,
  type UatActionState,
  type ReseedStatus,
} from "@/app/actions/admin-uat";
import {
  UAT_SECTIONS,
  CATEGORY_LABELS,
  SURFACE_LABEL,
  GO_NO_GO,
  type UatSection,
  type UatItem,
  type UatCategory,
  type UatAutomatedAction,
  type UatSurface,
} from "@/lib/uat/runbook-steps";
import { computeCategoryBreakdown, computeVerdict } from "@/lib/uat/verdict";
import { useT } from "@/components/locale-provider";

type UatTargetEnv = "preview" | "production";
type CheckResult = { label: string; pass: boolean; detail: string };
type CheckReport = { checks: CheckResult[]; pass: boolean };

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as UatCategory[];

const SURFACE_BADGE: Record<UatSurface, "info" | "warning" | "secondary" | "outline"> = {
  "teacher-web": "info",
  "student-web": "warning",
  web: "secondary",
  repo: "outline",
};

type WizardStep =
  | { kind: "item"; section: UatSection; item: UatItem }
  | { kind: "action"; section: UatSection; action: UatAutomatedAction }
  | { kind: "summary" };

function buildSteps(selected: Set<UatCategory>): WizardStep[] {
  const steps: WizardStep[] = [];
  for (const section of UAT_SECTIONS) {
    if (!selected.has(section.category)) continue;
    const items = section.items;
    for (const item of items) steps.push({ kind: "item", section, item });
    // Keep an action visible even when it has no items of its own
    // (e.g. category 0's probe).
    if (section.action && (items.length > 0 || section.items.length === 0)) {
      steps.push({ kind: "action", section, action: section.action });
    }
  }
  if (steps.length > 0) steps.push({ kind: "summary" });
  return steps;
}

function formatInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    parts.push(
      token.startsWith("**") ? (
        <strong key={key++} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>
      ) : (
        <code key={key++} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]">
          {token.slice(1, -1)}
        </code>
      ),
    );
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function isCheckReport(result: unknown): result is CheckReport {
  return (
    Boolean(result) && typeof result === "object" && Array.isArray((result as CheckReport).checks)
  );
}

function ResultBadges({ result }: { result: unknown }) {
  const t = useT();
  if (!isCheckReport(result)) return null;
  return (
    <ul className="mt-3 space-y-2">
      {result.checks.map((c) => (
        <li key={c.label} className="flex items-start gap-2 text-sm">
          <Badge variant={c.pass ? "success" : "destructive"} className="text-sm">
            {c.pass ? t("web.admin.uat.pass") : t("web.admin.uat.fail")}
          </Badge>
          <span>
            <span className="font-medium">{c.label}</span> — {c.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CopyChip({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={t("web.admin.uat.copyLabel", { label })}
      className="inline-flex min-h-target items-center gap-2 rounded-xl border-2 border-border bg-muted/50 px-3 py-2 font-mono text-base transition-colors active:bg-muted"
    >
      <span className="font-sans text-sm text-muted-foreground">{label}:</span>
      <span>{value}</span>
      {copied ? (
        <Check className="h-4 w-4 text-success" />
      ) : (
        <Copy className="h-4 w-4 text-muted-foreground" />
      )}
    </button>
  );
}

export function UatRunbook({
  initialChecked,
  isProdDeployment,
}: {
  initialChecked: Record<UatTargetEnv, string[]>;
  // From the server (lib/env.ts's isProductionDeployment()) — the actual
  // deployment this page is running on, independent of whatever the client
  // toggle below is set to. Reseed is already blocked server-side three
  // times over regardless (assertReseedAllowed, the Inngest function's own
  // check, and seedAll()'s DB-connection-string guard), but there's no
  // reason to even show a destructive control that's structurally
  // impossible to use here.
  isProdDeployment: boolean;
}) {
  const t = useT();
  const [env, setEnv] = useState<UatTargetEnv>("preview");
  // Defaults to "web": the first real paying student joins her class via
  // the browser, not the app, so that's the priority pass right now.
  const [checked, setChecked] = useState<Record<UatTargetEnv, Set<string>>>({
    preview: new Set(initialChecked.preview),
    production: new Set(initialChecked.production),
  });
  const [selectedCategories, setSelectedCategories] = useState<Set<UatCategory>>(
    () => new Set(ALL_CATEGORIES),
  );
  const [stepIndex, setStepIndex] = useState(0);

  const steps = useMemo(() => buildSteps(selectedCategories), [selectedCategories]);
  const step = steps[stepIndex] as WizardStep | undefined;

  const doneInView = steps.filter((s) => s.kind === "item" && checked[env].has(s.item.id)).length;
  const totalInView = steps.filter((s) => s.kind === "item").length;

  const [probeState, probeAction, probePending] = useActionState<UatActionState, FormData>(
    runUatProbeAction,
    undefined,
  );
  const [postHogState, postHogAction, postHogPending] = useActionState<UatActionState, FormData>(
    runPostHogCheckAction,
    undefined,
  );
  const [stripeBState, stripeBAction, stripeBPending] = useActionState<UatActionState, FormData>(
    runStripeCheckAction,
    undefined,
  );
  const [stripeGState, stripeGAction, stripeGPending] = useActionState<UatActionState, FormData>(
    runStripeCheckAction,
    undefined,
  );
  const [reseedState, reseedAction, reseedPending] = useActionState<UatActionState, FormData>(
    reseedPreviewAction,
    undefined,
  );
  const [bulkTeachers, setBulkTeachers] = useState("0");
  const [studentsPerBulkTeacher, setStudentsPerBulkTeacher] = useState("6");
  const [reseedStatus, setReseedStatus] = useState<ReseedStatus | null>(null);

  // Live Go/No-Go verdict — see lib/uat/verdict.ts for the pure computation.
  const categoryBreakdown = computeCategoryBreakdown(selectedCategories, checked[env]);
  const automatedChecks = [
    { label: t("web.admin.uat.checkProbe"), state: probeState },
    { label: t("web.admin.uat.checkPostHog"), state: postHogState },
    { label: t("web.admin.uat.checkStripePurchase"), state: stripeBState },
    { label: t("web.admin.uat.checkStripeRefund"), state: stripeGState },
  ]
    .map((c) => ({ ...c, report: isCheckReport(c.state?.result) ? c.state?.result : undefined }))
    .filter((c) => c.report != null || c.state?.error);
  const anyAutomatedFailure = automatedChecks.some(
    (c) => c.state?.error || c.report?.pass === false,
  );
  const verdict = computeVerdict(categoryBreakdown, anyAutomatedFailure);

  const queuedAt = (reseedState?.result as { queuedAt?: string } | undefined)?.queuedAt;
  const pollAttemptsRef = useRef(0);

  // Poll for the reseed's actual outcome — it runs in a separate Inngest
  // invocation, so the server action above only confirms it was queued.
  // Gives up after ~2 minutes (80 attempts) rather than polling forever if
  // something goes wrong before a completion/failure row is ever written.
  useEffect(() => {
    if (!queuedAt) return;
    pollAttemptsRef.current = 0;
    setReseedStatus({ status: "running" });
    let cancelled = false;
    const interval = setInterval(async () => {
      pollAttemptsRef.current += 1;
      const status = await getReseedStatusAction(queuedAt);
      if (cancelled) return;
      if (status.status !== "running") {
        setReseedStatus(status);
        clearInterval(interval);
      } else if (pollAttemptsRef.current >= 80) {
        clearInterval(interval);
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [queuedAt]);

  function toggleCategory(cat: UatCategory) {
    setSelectedCategories((prev) => {
      const copy = new Set(prev);
      if (copy.has(cat)) copy.delete(cat);
      else copy.add(cat);
      return copy;
    });
    setStepIndex(0);
  }

  function toggleItem(itemKey: string, next: boolean) {
    setChecked((prev) => {
      const copy = new Set(prev[env]);
      if (next) copy.add(itemKey);
      else copy.delete(itemKey);
      return { ...prev, [env]: copy };
    });
    const fd = new FormData();
    fd.set("env", env);
    fd.set("itemKey", itemKey);
    fd.set("checked", String(next));
    void toggleUatChecklistItemAction(undefined, fd);
    if (next) {
      setTimeout(() => setStepIndex((i) => Math.min(i + 1, steps.length - 1)), 400);
    }
  }

  const goBack = () => setStepIndex((i) => Math.max(0, i - 1));
  const goNext = () => setStepIndex((i) => Math.min(steps.length - 1, i + 1));

  function startAgain() {
    if (!confirm(t("web.admin.uat.startAgainConfirm", { env }))) return;
    setChecked((prev) => ({ ...prev, [env]: new Set<string>() }));
    setStepIndex(0);
    const fd = new FormData();
    fd.set("env", env);
    void clearUatChecklistAction(undefined, fd);
  }

  return (
    <div className="space-y-4">
      {/* Compact control bar: categories to run + environment + reseed. */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap gap-2">
            {ALL_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => toggleCategory(cat)}
                className={cn(
                  "min-h-target rounded-full border-2 px-4 py-2 text-sm font-medium transition-colors",
                  selectedCategories.has(cat)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground",
                )}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-4 border-t pt-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{t("web.admin.uat.target")}</span>
              <div className="inline-flex rounded-lg border-2 p-1">
                {(["preview", "production"] as const).map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setEnv(e)}
                    className={cn(
                      "min-h-10 rounded-md px-3 py-1.5 text-sm capitalize transition-colors",
                      env === e ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={startAgain}
              className="ml-auto"
            >
              <RotateCcw className="mr-1.5 h-4 w-4" />
              {t("web.admin.uat.startAgain")}
            </Button>
          </div>

          {isProdDeployment ? (
            <p className="border-t pt-4 text-sm text-muted-foreground">
              {t("web.admin.uat.reseedUnavailable")}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3 border-t pt-4">
                <form action={reseedAction} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="env" value={env} />
                  <div className="space-y-1">
                    <Label htmlFor="uat-bulk-teachers" className="text-xs">
                      {t("web.admin.uat.bulkTeachers")}
                    </Label>
                    <Input
                      id="uat-bulk-teachers"
                      name="bulkTeachers"
                      type="number"
                      min={0}
                      max={200}
                      value={bulkTeachers}
                      onChange={(e) => setBulkTeachers(e.target.value)}
                      className="h-10 w-24 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="uat-bulk-students" className="text-xs">
                      {t("web.admin.uat.studentsPerBulkTeacher")}
                    </Label>
                    <Input
                      id="uat-bulk-students"
                      name="studentsPerBulkTeacher"
                      type="number"
                      min={0}
                      max={50}
                      value={studentsPerBulkTeacher}
                      onChange={(e) => setStudentsPerBulkTeacher(e.target.value)}
                      className="h-10 w-24 text-sm"
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={env !== "preview" || reseedPending}
                  >
                    {reseedPending ? t("web.admin.uat.queuing") : t("web.admin.uat.reseedPreview")}
                  </Button>
                </form>
                {reseedState?.error ? (
                  <span className="text-sm text-destructive">{reseedState.error}</span>
                ) : null}
              </div>

              {reseedStatus ? (
                <div className="border-t pt-4">
                  {reseedStatus.status === "running" ? (
                    <Badge variant="info">{t("web.admin.uat.reseeding")}</Badge>
                  ) : reseedStatus.status === "completed" ? (
                    <Badge variant="success">
                      {t("web.admin.uat.reseededSummary", {
                        teachers: reseedStatus.summary.teachers,
                        students: reseedStatus.summary.students,
                      })}
                    </Badge>
                  ) : (
                    <div className="flex items-start gap-2">
                      <Badge variant="destructive">{t("web.admin.uat.failed")}</Badge>
                      <span className="text-sm text-destructive">{reseedStatus.error}</span>
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {step ? (
        <>
          {/* Progress. */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {t("web.admin.uat.stepOf", { current: stepIndex + 1, total: steps.length })}
              </span>
              <span>{t("web.admin.uat.stepsDone", { done: doneInView, total: totalInView })}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${steps.length ? ((stepIndex + 1) / steps.length) * 100 : 0}%` }}
              />
            </div>
          </div>

          {/* The one step. */}
          <Card className="border-2">
            <CardContent className="space-y-5 pt-6">
              {step.kind !== "summary" ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-sm">
                      {step.section.title}
                    </Badge>
                    {step.kind === "item" && step.item.surface ? (
                      <Badge variant={SURFACE_BADGE[step.item.surface]} className="text-sm">
                        {SURFACE_LABEL[step.item.surface]}
                      </Badge>
                    ) : null}
                  </div>

                  {step.section.note ? (
                    <p className="rounded-xl border-l-4 border-border bg-muted/30 p-4 text-base text-muted-foreground">
                      {formatInline(step.section.note)}
                    </p>
                  ) : null}
                </>
              ) : null}

              {step.kind === "summary" ? (
                <div className="space-y-5">
                  <div
                    className={cn(
                      "rounded-xl p-5 text-center",
                      verdict === "GO" && "bg-success-bg",
                      verdict === "NO_GO" && "bg-destructive-bg",
                      verdict === "INCOMPLETE" && "bg-warning-bg",
                    )}
                  >
                    <p
                      className={cn(
                        "text-2xl font-bold",
                        verdict === "GO" && "text-success",
                        verdict === "NO_GO" && "text-destructive",
                        verdict === "INCOMPLETE" && "text-warning",
                      )}
                    >
                      {verdict === "GO"
                        ? `✓ ${t("web.admin.uat.go")}`
                        : verdict === "NO_GO"
                          ? `✗ ${t("web.admin.uat.noGo")}`
                          : `◐ ${t("web.admin.uat.incomplete")}`}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {verdict === "GO"
                        ? t("web.admin.uat.verdictGoBody")
                        : verdict === "NO_GO"
                          ? t("web.admin.uat.verdictNoGoBody")
                          : t("web.admin.uat.verdictIncompleteBody")}
                    </p>
                  </div>

                  <div>
                    <p className="mb-2 text-sm font-medium">
                      {t("web.admin.uat.coverageByCategory")}
                    </p>
                    <ul className="space-y-1.5 text-sm">
                      {categoryBreakdown.map((c) => (
                        <li key={c.category} className="flex items-center justify-between">
                          <span>{CATEGORY_LABELS[c.category]}</span>
                          <Badge
                            variant={c.total === 0 || c.done === c.total ? "success" : "warning"}
                          >
                            {c.done} / {c.total}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {automatedChecks.length > 0 ? (
                    <div>
                      <p className="mb-2 text-sm font-medium">
                        {t("web.admin.uat.automatedChecks")}
                      </p>
                      <ul className="space-y-1.5 text-sm">
                        {automatedChecks.map((c) => (
                          <li key={c.label} className="flex items-center justify-between">
                            <span>{c.label}</span>
                            <Badge
                              variant={
                                c.state?.error || c.report?.pass === false
                                  ? "destructive"
                                  : "success"
                              }
                            >
                              {c.state?.error
                                ? t("web.admin.uat.error")
                                : c.report?.pass === false
                                  ? t("web.admin.uat.fail")
                                  : t("web.admin.uat.pass")}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div>
                    <p className="mb-2 text-sm font-medium text-muted-foreground">
                      {t("web.admin.uat.notBlocking")}
                    </p>
                    <ul className="space-y-1.5 text-sm text-muted-foreground">
                      {GO_NO_GO.notBlocking.map((line) => (
                        <li key={line}>• {line}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}

              {step.kind === "item" ? (
                <>
                  {step.item.loginAs ? (
                    <div className="rounded-xl bg-primary/10 p-4">
                      <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
                        {t("web.admin.uat.signedInAs")}
                      </p>
                      <p className="mb-2 font-medium">{step.item.loginAs.name}</p>
                      <CopyChip label={t("common.email")} value={step.item.loginAs.email} />
                    </div>
                  ) : null}

                  <p className="text-lg leading-relaxed">{formatInline(step.item.text)}</p>

                  {step.item.copyValues?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {step.item.copyValues.map((cv) => (
                        <CopyChip key={cv.label} label={cv.label} value={cv.value} />
                      ))}
                    </div>
                  ) : null}

                  {step.item.expect ? (
                    <p className="text-base text-muted-foreground">
                      ✅ {formatInline(step.item.expect)}
                    </p>
                  ) : null}

                  <label className="flex min-h-[3.5rem] cursor-pointer items-center gap-3 rounded-xl border-2 border-border p-4 active:bg-muted/50">
                    <input
                      type="checkbox"
                      checked={checked[env].has(step.item.id)}
                      onChange={(e) => toggleItem(step.item.id, e.target.checked)}
                      className="h-6 w-6 shrink-0 accent-primary"
                    />
                    <span className="text-base font-medium">{t("web.admin.uat.done")}</span>
                  </label>
                </>
              ) : null}

              {step.kind === "action" && step.action === "probe" ? (
                <div className="space-y-2">
                  <form action={probeAction}>
                    <input type="hidden" name="env" value={env} />
                    <Button type="submit" size="lg" className="w-full" disabled={probePending}>
                      {probePending
                        ? t("web.admin.uat.running")
                        : `▶ ${t("web.admin.uat.runProbe")}`}
                    </Button>
                  </form>
                  {probeState?.error ? (
                    <p className="text-sm text-destructive">{probeState.error}</p>
                  ) : null}
                  <ResultBadges result={probeState?.result} />
                </div>
              ) : null}

              {step.kind === "action" && step.action === "posthog" ? (
                <div className="space-y-2">
                  <form action={postHogAction}>
                    <input type="hidden" name="env" value={env} />
                    <Button type="submit" size="lg" className="w-full" disabled={postHogPending}>
                      {postHogPending
                        ? t("web.admin.uat.checking")
                        : t("web.admin.uat.runPostHogCheck")}
                    </Button>
                  </form>
                  {postHogState?.error ? (
                    <p className="text-sm text-destructive">{postHogState.error}</p>
                  ) : null}
                  <ResultBadges result={postHogState?.result} />
                </div>
              ) : null}

              {step.kind === "action" && step.action === "stripe" && step.section.id === "B" ? (
                <div className="space-y-2">
                  <form action={stripeBAction} className="space-y-2">
                    <input type="hidden" name="env" value={env} />
                    <Label htmlFor="uat-b-email">{t("web.admin.uat.studentEmail")}</Label>
                    <Input
                      id="uat-b-email"
                      name="studentEmail"
                      defaultValue="alumno.uat@spiralclass.com"
                      className="h-12 text-base"
                    />
                    <Button type="submit" size="lg" className="w-full" disabled={stripeBPending}>
                      {stripeBPending
                        ? t("web.admin.uat.checking")
                        : t("web.admin.uat.runStripeCheck")}
                    </Button>
                  </form>
                  {stripeBState?.error ? (
                    <p className="text-sm text-destructive">{stripeBState.error}</p>
                  ) : null}
                  <ResultBadges result={stripeBState?.result} />
                </div>
              ) : null}

              {step.kind === "action" && step.action === "stripe" && step.section.id === "G" ? (
                <div className="space-y-2">
                  <form action={stripeGAction} className="space-y-2">
                    <input type="hidden" name="env" value={env} />
                    <Label htmlFor="uat-g-payment">
                      {t("web.admin.uat.paymentIdFromPurchase")}
                    </Label>
                    <Input
                      id="uat-g-payment"
                      name="paymentId"
                      placeholder="uuid"
                      className="h-12 text-base"
                    />
                    <Button type="submit" size="lg" className="w-full" disabled={stripeGPending}>
                      {stripeGPending
                        ? t("web.admin.uat.checking")
                        : t("web.admin.uat.runStripeCheck")}
                    </Button>
                  </form>
                  {stripeGState?.error ? (
                    <p className="text-sm text-destructive">{stripeGState.error}</p>
                  ) : null}
                  <ResultBadges result={stripeGState?.result} />
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Big nav. */}
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-14 flex-1 text-base"
              onClick={goBack}
              disabled={stepIndex === 0}
            >
              <ChevronLeft className="mr-1 h-5 w-5" />
              {t("common.back")}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-14 flex-1 text-base"
              onClick={goNext}
              disabled={stepIndex === steps.length - 1}
            >
              {t("common.next")}
              <ChevronRight className="ml-1 h-5 w-5" />
            </Button>
          </div>
        </>
      ) : (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            {t("web.admin.uat.pickCategory")}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
