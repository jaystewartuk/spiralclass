"use client";

import { Heading } from "@/components/ui/heading";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/components/locale-provider";
import {
  previewInvitesAction,
  sendInvitesAction,
  type InviteFormState,
} from "@/app/actions/invitations";

export type EligibleStudent = { id: string; name: string; email: string };

type Tab = "single" | "paste" | "roster";

export function InviteForm({
  eligible,
  preselectStudentId,
}: {
  eligible: EligibleStudent[];
  preselectStudentId: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(preselectStudentId ? "roster" : "single");
  const [pending, startTransition] = useTransition();

  // single
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  // paste
  const [list, setList] = useState("");
  // roster multi-select
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselectStudentId ? [preselectStudentId] : []),
  );

  const [preview, setPreview] = useState<NonNullable<InviteFormState>["preview"] | null>(null);

  const buildFormData = (): FormData | null => {
    const fd = new FormData();
    fd.set("source", tab === "single" ? "single" : "bulk");
    if (tab === "single") {
      if (!email.trim()) return null;
      fd.set("list", name.trim() ? `${name.trim()}, ${email.trim()}` : email.trim());
    } else if (tab === "paste") {
      if (!list.trim()) return null;
      fd.set("list", list);
    } else {
      if (selected.size === 0) return null;
      fd.set("studentIds", JSON.stringify([...selected]));
    }
    return fd;
  };

  const onReview = () => {
    const fd = buildFormData();
    if (!fd) {
      toast.error(t("web.dashboard.invitations.form.willSend", { count: "0" }));
      return;
    }
    startTransition(async () => {
      const res = await previewInvitesAction(undefined, fd);
      if (res?.error) toast.error(res.error);
      else if (res?.preview) setPreview(res.preview);
    });
  };

  const onSend = () => {
    const fd = buildFormData();
    if (!fd) return;
    startTransition(async () => {
      const res = await sendInvitesAction(undefined, fd);
      if (res?.error) toast.error(res.error);
      else {
        if (res?.ok) toast.success(res.ok);
        router.push("/dashboard/students/invitations");
      }
    });
  };

  if (preview) {
    return (
      <ConfirmScreen
        preview={preview}
        pending={pending}
        onBack={() => setPreview(null)}
        onSend={onSend}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex gap-1.5">
        {(["single", "paste", "roster"] as Tab[]).map((tk) => (
          <button
            key={tk}
            type="button"
            onClick={() => setTab(tk)}
            aria-pressed={tab === tk}
            className={
              tab === tk
                ? "bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium"
                : "bg-muted text-muted-foreground hover:bg-muted/70 rounded-md px-3 py-1.5 text-sm font-medium"
            }
          >
            {t(
              tk === "single"
                ? "web.dashboard.invitations.form.tabSingle"
                : tk === "paste"
                  ? "web.dashboard.invitations.form.tabPaste"
                  : "web.dashboard.invitations.form.tabRoster",
            )}
          </button>
        ))}
      </div>

      {tab === "single" && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="invite-email">{t("web.dashboard.invitations.form.emailLabel")}</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="invite-name">{t("web.dashboard.invitations.form.nameLabel")}</Label>
            <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
      )}

      {tab === "paste" && (
        <div className="space-y-1">
          <Label htmlFor="invite-list">{t("web.dashboard.invitations.form.pasteLabel")}</Label>
          <Textarea
            id="invite-list"
            rows={8}
            value={list}
            onChange={(e) => setList(e.target.value)}
            placeholder={t("web.dashboard.invitations.form.pastePlaceholder")}
          />
          <p className="text-muted-foreground text-xs">
            {t("web.dashboard.invitations.form.pasteHint")}
          </p>
        </div>
      )}

      {tab === "roster" && (
        <RosterPicker eligible={eligible} selected={selected} setSelected={setSelected} />
      )}

      <Button onClick={onReview} disabled={pending}>
        {t("web.dashboard.invitations.form.preview")}
      </Button>
    </div>
  );
}

function RosterPicker({
  eligible,
  selected,
  setSelected,
}: {
  eligible: EligibleStudent[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
}) {
  const t = useT();
  if (eligible.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("web.dashboard.invitations.form.rosterEmpty")}
      </p>
    );
  }
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {t("web.dashboard.invitations.form.rosterHint")}
      </p>
      <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
        {eligible.map((s) => (
          <li key={s.id}>
            <label className="hover:bg-muted/40 flex cursor-pointer items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
                className="size-4"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                <span className="text-muted-foreground block truncate text-xs">{s.email}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfirmScreen({
  preview,
  pending,
  onBack,
  onSend,
}: {
  preview: NonNullable<NonNullable<InviteFormState>["preview"]>;
  pending: boolean;
  onBack: () => void;
  onSend: () => void;
}) {
  const t = useT();
  const dispVariant: Record<string, "success" | "secondary" | "outline" | "warning"> = {
    ok: "success",
    duplicate_in_list: "secondary",
    already_connected: "outline",
    already_invited: "warning",
  };
  const rowsToShow = useMemo(() => preview.rows, [preview.rows]);
  return (
    <div className="space-y-4">
      <div>
        <Heading level={3} as="h2">
          {t("web.dashboard.invitations.form.confirmTitle")}
        </Heading>
        <p className="text-muted-foreground text-sm">
          {t("web.dashboard.invitations.form.willSend", { count: String(preview.sendableCount) })}
        </p>
      </div>

      {preview.invalidCount > 0 && (
        <p className="text-muted-foreground text-sm">
          {t("web.dashboard.invitations.form.invalidCount", {
            count: String(preview.invalidCount),
          })}
        </p>
      )}
      {preview.truncated && (
        <p className="text-muted-foreground text-sm">
          {t("web.dashboard.invitations.form.truncated")}
        </p>
      )}

      <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
        {rowsToShow.map((r, i) => (
          <li key={`${r.email}-${i}`} className="flex items-center justify-between gap-2 px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{r.name ?? r.email}</span>
              {r.name && (
                <span className="text-muted-foreground block truncate text-xs">{r.email}</span>
              )}
            </span>
            <Badge variant={dispVariant[r.disposition] ?? "outline"}>
              {t(`web.dashboard.invitations.form.disp.${r.disposition}`)}
            </Badge>
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack} disabled={pending}>
          {t("web.dashboard.invitations.form.editList")}
        </Button>
        <Button onClick={onSend} disabled={pending || preview.sendableCount === 0}>
          {pending
            ? t("web.dashboard.invitations.form.sending")
            : t("web.dashboard.invitations.form.send")}
        </Button>
      </div>
    </div>
  );
}
