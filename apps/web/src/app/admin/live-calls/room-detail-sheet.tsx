"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useVisibilityPolling } from "@/hooks/use-visibility-polling";
import { useT } from "@/components/locale-provider";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/live-calls/format";
import type { LiveCallDetail, LiveCallParticipantDetail } from "@/lib/live-calls/types";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

const POLL_MS = 4_000;

type DetailState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error" }
  | { status: "ready"; data: LiveCallDetail };

// Lazy-loaded detail panel: fetches /api/admin/live-calls/[room] only while
// open, and polls it a bit faster than the list (the whole point of opening
// it is watching one room closely). Closing unmounts the poll entirely.
export function RoomDetailSheet({
  room,
  onOpenChange,
  onActionDone,
}: {
  room: string | null;
  onOpenChange: (open: boolean) => void;
  onActionDone: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<DetailState>({ status: "loading" });

  const fetchDetail = useCallback(async () => {
    if (!room) return;
    try {
      const res = await fetchWithTimeout(`/api/admin/live-calls/${encodeURIComponent(room)}`, {
        cache: "no-store",
      });
      if (res.status === 404) {
        setState({ status: "not-found" });
        return;
      }
      if (!res.ok) {
        setState({ status: "error" });
        return;
      }
      const json = (await res.json()) as { room: LiveCallDetail };
      setState({ status: "ready", data: json.room });
    } catch {
      setState({ status: "error" });
    }
  }, [room]);

  useEffect(() => {
    if (room) setState({ status: "loading" });
  }, [room]);

  useVisibilityPolling(fetchDetail, { intervalMs: POLL_MS, enabled: room !== null });

  return (
    <Sheet open={room !== null} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t("web.admin.liveCalls.detail.title")}</SheetTitle>
          {room && <SheetDescription className="font-mono">{room}</SheetDescription>}
        </SheetHeader>

        {state.status === "loading" && (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {state.status === "not-found" && (
          <p className="text-muted-foreground text-sm">
            {t("web.admin.liveCalls.detail.notFound")}
          </p>
        )}

        {state.status === "error" && (
          <p className="text-destructive text-sm">{t("web.admin.liveCalls.detail.loadError")}</p>
        )}

        {state.status === "ready" && room && (
          <RoomDetailBody
            room={room}
            detail={state.data}
            onActionDone={() => {
              onActionDone();
              void fetchDetail();
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function RoomDetailBody({
  room,
  detail,
  onActionDone,
}: {
  room: string;
  detail: LiveCallDetail;
  onActionDone: () => void;
}) {
  const t = useT();

  return (
    <div className="space-y-4">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={detail.kind === "unknown" ? "outline" : "secondary"}>
          {t(`web.admin.liveCalls.kind.${detail.kind}`)}
        </Badge>
        <span>{formatDuration(detail.durationSec)}</span>
        <Badge variant={detail.fullyConnected ? "success" : "warning"}>
          {t(
            detail.fullyConnected
              ? "web.admin.liveCalls.status.full"
              : "web.admin.liveCalls.status.waiting",
          )}
        </Badge>
      </div>

      <EndRoomButton room={room} onDone={onActionDone} />

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("web.admin.liveCalls.detail.participants")}</h3>
        {detail.participants.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("web.admin.liveCalls.empty")}</p>
        ) : (
          detail.participants.map((p) => (
            <ParticipantCard key={p.identity} room={room} participant={p} onDone={onActionDone} />
          ))
        )}
      </div>
    </div>
  );
}

function ParticipantCard({
  room,
  participant,
  onDone,
}: {
  room: string;
  participant: LiveCallParticipantDetail;
  onDone: () => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">{participant.name}</div>
          <div className="text-muted-foreground text-xs">
            {t(`web.admin.liveCalls.detail.role.${participant.role}`)} ·{" "}
            {t(`web.admin.liveCalls.detail.state.${participant.state}`)}
          </div>
        </div>
        <DisconnectButton room={room} participant={participant} onDone={onDone} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant={participant.audioPublishing ? "success" : "outline"}>
          {t("web.admin.liveCalls.detail.audio")}
        </Badge>
        <Badge variant={participant.videoPublishing ? "success" : "outline"}>
          {t("web.admin.liveCalls.detail.video")}
        </Badge>
        {participant.screenSharing && (
          <Badge variant="info">{t("web.admin.liveCalls.detail.screenShare")}</Badge>
        )}
      </div>
      <div className="text-muted-foreground text-xs">
        {t("web.admin.liveCalls.detail.joinedAgo", {
          duration: formatDuration(participant.durationSec),
        })}
      </div>
    </div>
  );
}

function EndRoomButton({ room, onDone }: { room: string; onDone: () => void }) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  async function handleConfirm(close: () => void) {
    const trimmed = reason.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      const res = await fetchWithTimeout(`/api/admin/live-calls/${encodeURIComponent(room)}/end`, {
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
        <Button variant="destructive" size="sm" className="w-full">
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

function DisconnectButton({
  room,
  participant,
  onDone,
}: {
  room: string;
  participant: LiveCallParticipantDetail;
  onDone: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  async function handleConfirm(close: () => void) {
    const trimmed = reason.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      const res = await fetchWithTimeout(
        `/api/admin/live-calls/${encodeURIComponent(room)}/participants/${encodeURIComponent(participant.identity)}/disconnect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: trimmed }),
        },
      );
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        toast.success(t("web.admin.liveCalls.disconnectSuccess"));
        setReason("");
        close();
        onDone();
      } else {
        toast.error(t("web.admin.liveCalls.disconnectError"));
      }
    } catch {
      toast.error(t("web.admin.liveCalls.disconnectError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm">
          {t("web.admin.liveCalls.disconnect")}
        </Button>
      }
      title={t("web.admin.liveCalls.disconnectConfirmTitle", { name: participant.name })}
      description={t("web.admin.liveCalls.disconnectConfirmDescription")}
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
            {pending ? "…" : t("web.admin.liveCalls.disconnect")}
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
