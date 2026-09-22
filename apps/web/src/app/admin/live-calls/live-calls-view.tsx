"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useVisibilityPolling } from "@/hooks/use-visibility-polling";
import { useT } from "@/components/locale-provider";
import { StatCard } from "@/components/ui/stat";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableShell,
} from "@/components/ui/table";
import { formatDuration } from "@/lib/live-calls/format";
import { RoomDetailSheet } from "./room-detail-sheet";
import type {
  CallKind,
  LiveCallsDashboard,
  LiveCallsListResult,
  LiveCallSummary,
} from "@/lib/live-calls/types";

const POLL_MS = 5_000;

export type LiveCallsInitialState =
  { kind: "ready"; data: LiveCallsListResult } | { kind: "not-configured" } | { kind: "error" };

type ViewState = {
  data: LiveCallsListResult | null;
  notConfigured: boolean;
  // A poll failed but we're keeping the last-known-good data on screen
  // (with a warning banner) rather than blanking the page over a blip.
  errored: boolean;
};

function initialViewState(initial: LiveCallsInitialState): ViewState {
  if (initial.kind === "ready") return { data: initial.data, notConfigured: false, errored: false };
  if (initial.kind === "not-configured") return { data: null, notConfigured: true, errored: false };
  return { data: null, notConfigured: false, errored: true };
}

const EMPTY_DASHBOARD: LiveCallsDashboard = {
  activeRooms: 0,
  activeParticipants: 0,
  roomsFullyConnected: 0,
  roomsWaitingForCounterpart: 0,
  avgParticipantsPerRoom: 0,
  lastUpdatedMs: 0,
};

export function LiveCallsView({ initial }: { initial: LiveCallsInitialState }) {
  const t = useT();
  const [state, setState] = useState<ViewState>(() => initialViewState(initial));
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | CallKind>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "full" | "waiting">("all");
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/live-calls", { cache: "no-store" });
      if (res.status === 503) {
        setState((prev) => ({ ...prev, notConfigured: true, errored: false }));
        return;
      }
      if (!res.ok) {
        setState((prev) => ({ ...prev, errored: true }));
        return;
      }
      const json = (await res.json()) as {
        dashboard: LiveCallsDashboard;
        rooms: LiveCallSummary[];
      };
      setState({
        data: { dashboard: json.dashboard, rooms: json.rooms },
        notConfigured: false,
        errored: false,
      });
    } catch {
      setState((prev) => ({ ...prev, errored: true }));
    }
  }, []);

  useVisibilityPolling(fetchList, { intervalMs: POLL_MS });

  const dashboard = state.data?.dashboard ?? EMPTY_DASHBOARD;
  const rooms = useMemo(() => state.data?.rooms ?? [], [state.data]);

  const filteredRooms = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rooms.filter((r) => {
      if (kindFilter !== "all" && r.kind !== kindFilter) return false;
      if (statusFilter === "full" && !r.fullyConnected) return false;
      if (statusFilter === "waiting" && r.fullyConnected) return false;
      if (!q) return true;
      return (
        r.room.toLowerCase().includes(q) ||
        (r.teacher?.name.toLowerCase().includes(q) ?? false) ||
        (r.student?.name.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rooms, query, kindFilter, statusFilter]);

  if (state.notConfigured) {
    return (
      <Alert>
        <AlertDescription>{t("web.admin.liveCalls.notConfigured")}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {state.errored && (
        <Alert variant="destructive">
          <AlertDescription>{t("web.admin.liveCalls.unavailable")}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label={t("web.admin.liveCalls.stat.activeRooms")} value={dashboard.activeRooms} />
        <StatCard
          label={t("web.admin.liveCalls.stat.activeParticipants")}
          value={dashboard.activeParticipants}
        />
        <StatCard
          label={t("web.admin.liveCalls.stat.fullyConnected")}
          value={dashboard.roomsFullyConnected}
        />
        <StatCard
          label={t("web.admin.liveCalls.stat.waiting")}
          value={dashboard.roomsWaitingForCounterpart}
          danger={dashboard.roomsWaitingForCounterpart > 0}
        />
        <StatCard
          label={t("web.admin.liveCalls.stat.avgParticipants")}
          value={dashboard.avgParticipantsPerRoom}
        />
        <StatCard
          label={t("web.admin.liveCalls.stat.lastUpdated")}
          value={
            dashboard.lastUpdatedMs ? new Date(dashboard.lastUpdatedMs).toLocaleTimeString() : "—"
          }
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-4">
        <label className="min-w-[220px] flex-1 space-y-1 text-xs">
          <span className="text-muted-foreground">
            {t("web.admin.liveCalls.searchPlaceholder")}
          </span>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("web.admin.liveCalls.searchPlaceholder")}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("web.admin.liveCalls.filterKindLabel")}</span>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as "all" | CallKind)}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="all">{t("web.admin.liveCalls.filterKindAll")}</option>
            <option value="class">{t("web.admin.liveCalls.kind.class")}</option>
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">
            {t("web.admin.liveCalls.filterStatusLabel")}
          </span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | "full" | "waiting")}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="all">{t("web.admin.liveCalls.filterStatusAll")}</option>
            <option value="full">{t("web.admin.liveCalls.filterStatusFull")}</option>
            <option value="waiting">{t("web.admin.liveCalls.filterStatusWaiting")}</option>
          </select>
        </label>
      </div>

      {rooms.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("web.admin.liveCalls.empty")}
        </div>
      ) : filteredRooms.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("web.admin.liveCalls.noneMatched")}
        </div>
      ) : (
        <TableShell>
          <Table className="table-stack">
            <TableHeader>
              <TableRow>
                <TableHead data-label={t("web.admin.liveCalls.table.room")}>
                  {t("web.admin.liveCalls.table.kind")}
                </TableHead>
                <TableHead>{t("web.admin.liveCalls.table.teacher")}</TableHead>
                <TableHead>{t("web.admin.liveCalls.table.student")}</TableHead>
                <TableHead>{t("web.admin.liveCalls.table.participants")}</TableHead>
                <TableHead>{t("web.admin.liveCalls.table.duration")}</TableHead>
                <TableHead>{t("web.admin.liveCalls.table.status")}</TableHead>
                <TableHead>{t("web.admin.liveCalls.table.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRooms.map((room) => (
                <TableRow key={room.room}>
                  <TableCell data-label={t("web.admin.liveCalls.table.kind")}>
                    <div className="flex flex-col gap-0.5">
                      <Badge variant={room.kind === "unknown" ? "outline" : "secondary"}>
                        {t(`web.admin.liveCalls.kind.${room.kind}`)}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">{room.room}</span>
                    </div>
                  </TableCell>
                  <TableCell data-label={t("web.admin.liveCalls.table.teacher")}>
                    {room.teacher?.name ?? t("web.admin.liveCalls.unknownParty")}
                  </TableCell>
                  <TableCell data-label={t("web.admin.liveCalls.table.student")}>
                    {room.student?.name ?? t("web.admin.liveCalls.unknownParty")}
                  </TableCell>
                  <TableCell data-label={t("web.admin.liveCalls.table.participants")}>
                    {room.numParticipants}
                  </TableCell>
                  <TableCell data-label={t("web.admin.liveCalls.table.duration")}>
                    {formatDuration(room.durationSec)}
                  </TableCell>
                  <TableCell data-label={t("web.admin.liveCalls.table.status")}>
                    <Badge variant={room.fullyConnected ? "success" : "warning"}>
                      {t(
                        room.fullyConnected
                          ? "web.admin.liveCalls.status.full"
                          : "web.admin.liveCalls.status.waiting",
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell data-label={t("web.admin.liveCalls.table.actions")}>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedRoom(room.room)}
                      >
                        {t("web.admin.liveCalls.viewDetail")}
                      </Button>
                      <EndCallButton room={room.room} onDone={fetchList} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableShell>
      )}

      <RoomDetailSheet
        room={selectedRoom}
        onOpenChange={(open) => {
          if (!open) setSelectedRoom(null);
        }}
        onActionDone={fetchList}
      />
    </div>
  );
}

function EndCallButton({ room, onDone }: { room: string; onDone: () => void }) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  async function handleConfirm(close: () => void) {
    const trimmed = reason.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      const res = await fetch(`/api/admin/live-calls/${encodeURIComponent(room)}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        toast.success(t("web.admin.liveCalls.endCallSuccess"));
        setReason("");
        close();
        onDone();
      } else {
        toast.error(t("web.admin.liveCalls.endCallError"));
      }
    } catch {
      toast.error(t("web.admin.liveCalls.endCallError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <ConfirmDialog
      trigger={
        <Button variant="destructive" size="sm">
          {t("web.admin.liveCalls.endCall")}
        </Button>
      }
      title={t("web.admin.liveCalls.endCallConfirmTitle")}
      description={t("web.admin.liveCalls.endCallConfirmDescription", { room })}
      footer={(close) => (
        <>
          <Button variant="ghost" size="sm" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending || !reason.trim()}
            onClick={() => handleConfirm(close)}
          >
            {pending ? "…" : t("web.admin.liveCalls.endCall")}
          </Button>
        </>
      )}
    >
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("web.admin.liveCalls.reasonPlaceholder")}
        aria-label={t("web.admin.liveCalls.reasonLabel")}
      />
    </ConfirmDialog>
  );
}
