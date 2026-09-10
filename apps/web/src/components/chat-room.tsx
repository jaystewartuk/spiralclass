"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppLocale, ChatMessage } from "@spiralclass/shared";
import { canDeleteChatMessage } from "@spiralclass/shared";
import { ArrowDown, Copy, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ChatComposer } from "@/components/chat/chat-composer";
import { EmojiPickerDialog } from "@/components/chat/emoji-picker-dialog";
import { MessageBubble } from "@/components/chat/message-bubble";
import { PersonAvatar } from "@/components/teacher-identity";
import { useVisibilityPolling } from "@/hooks/use-visibility-polling";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { useVideoRecorder } from "@/hooks/use-video-recorder";
import { useT } from "@/components/locale-provider";
import { chatMessageKind, dayDividerLabel, messageToClipboardText } from "@/lib/chat/labels";
import {
  CHAT_PAGE_SIZE,
  buildChatRows,
  groupRowsByDay,
  dropPendingMessage,
  isPendingMessage,
  isScrolledToBottom,
  mergeChatMessages,
  newPendingId,
  prependChatMessages,
  replacePendingMessage,
  unseenSince,
} from "@/lib/chat/view-model";

// Direct-to-R2 upload for chat media (bypasses the platform's request-body
// limit). GET a presigned PUT ticket from the media route, PUT the file
// straight to R2, then POST the storage path (plus any per-kind metadata) back
// to finalize. The browser→R2 PUT is cross-origin, so the R2 bucket must allow
// PUT/GET from the app origins in its CORS policy. Throws on any failure.
async function uploadPresignedMedia(
  routeUrl: string,
  blob: Blob,
  contentType: string,
  extra: Record<string, unknown>,
): Promise<ChatMessage> {
  const ticketRes = await fetch(`${routeUrl}?contentType=${encodeURIComponent(contentType)}`, {
    credentials: "same-origin",
  });
  const ticket = (await ticketRes.json().catch(() => ({}))) as {
    uploadUrl?: string;
    storagePath?: string;
    reason?: string;
  };
  if (!ticketRes.ok || !ticket.uploadUrl || !ticket.storagePath) {
    throw new Error(ticket.reason ?? "presign-failed");
  }
  const putRes = await fetch(ticket.uploadUrl, {
    method: "PUT",
    body: blob,
    headers: { "Content-Type": contentType },
  });
  if (!putRes.ok) throw new Error(`r2-upload-${putRes.status}`);
  const finalizeRes = await fetch(routeUrl, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storagePath: ticket.storagePath, ...extra }),
  });
  if (!finalizeRes.ok) throw new Error(`finalize-${finalizeRes.status}`);
  return (await finalizeRes.json()) as ChatMessage;
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = URL.createObjectURL(file);
  });
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Which surface asked for the full emoji grid. */
type EmojiTarget = { kind: "composer" } | { kind: "message"; id: string };

export function ChatRoom({
  messagesUrl,
  voiceUrl,
  videoUrl: videoUploadUrl,
  imageUrl: imageUploadUrl,
  fileUrl: fileUploadUrl,
  myRole,
  peerName,
  peerPhotoUrl,
  locale,
  initialMessages,
}: {
  messagesUrl: string;
  voiceUrl: string;
  videoUrl: string;
  imageUrl: string;
  fileUrl: string;
  myRole: "teacher" | "student";
  /** The other party's name, used for the per-run screen-reader sender label
   * and the empty state. */
  peerName: string;
  /** The other party's photo, shown only where the thread names them — the
   * empty state and the start-of-conversation marker. Bubbles carry no avatar:
   * in a two-person thread the side of the column already says who is talking,
   * and a repeated 32px face down one edge is noise. */
  peerPhotoUrl?: string | null;
  locale: AppLocale;
  initialMessages: ChatMessage[];
}) {
  const t = useT();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [emojiTarget, setEmojiTarget] = useState<EmojiTarget | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const draftBeforeEditRef = useRef("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatMessage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // History paging. The route already accepts a `?before=` cursor; nothing was
  // calling it, so a thread simply stopped at its fiftieth message with no way
  // back through it.
  const [hasOlder, setHasOlder] = useState(initialMessages.length >= CHAT_PAGE_SIZE);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Follow-the-conversation state. An arriving message must not yank a reader
  // who has scrolled up to re-read something — it raises a counter instead.
  const [followingLatest, setFollowingLatest] = useState(true);
  const followingLatestRef = useRef(true);
  const lastSeenIdRef = useRef<string | null>(null);
  const [unseen, setUnseen] = useState(0);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);

  const {
    state: voiceRecorderState,
    elapsedMs: voiceElapsedMs,
    startRecording: startVoice,
    stopRecording: stopVoice,
    cancelRecording: cancelVoice,
  } = useVoiceRecorder();

  const {
    state: videoRecorderState,
    elapsedMs: videoElapsedMs,
    previewRef,
    startRecording: startVideo,
    stopRecording: stopVideo,
    cancelRecording: cancelVideo,
  } = useVideoRecorder();

  const isRecording = voiceRecorderState === "recording" || videoRecorderState === "recording";

  const scrollToBottom = useCallback((animated: boolean) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: animated && !prefersReducedMotion() ? "smooth" : "instant",
    });
  }, []);

  const jumpToLatest = useCallback(() => {
    lastSeenIdRef.current = messages[messages.length - 1]?.id ?? null;
    setUnseen(0);
    setFollowingLatest(true);
    followingLatestRef.current = true;
    scrollToBottom(true);
  }, [messages, scrollToBottom]);

  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const bottom = isScrolledToBottom(el);
    followingLatestRef.current = bottom;
    setFollowingLatest(bottom);
  }, []);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(messagesUrl, { credentials: "same-origin" });
      if (!res.ok) return;
      const data: ChatMessage[] = await res.json();
      setMessages((prev) => mergeChatMessages(prev, data));
    } catch {
      // Network error — the next poll retries.
    }
  }, [messagesUrl]);

  // Keep the view pinned to the newest message while the reader is following
  // the conversation, and count what they missed while they are not.
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    if (last.id === lastSeenIdRef.current) return;
    const firstPaint = lastSeenIdRef.current === null;
    if (firstPaint || followingLatestRef.current || last.senderRole === myRole) {
      lastSeenIdRef.current = last.id;
      setUnseen(0);
      scrollToBottom(!firstPaint);
      return;
    }
    setUnseen(unseenSince(messages, lastSeenIdRef.current));
  }, [messages, myRole, scrollToBottom]);

  // Portable near-real-time delivery: fast-poll the canonical list while the
  // tab is visible, refetch instantly when it regains focus, and pause while
  // it is hidden. `useVisibilityPolling` was extracted FROM this component and
  // then never adopted by it — the two copies had already started to differ.
  useVisibilityPolling(fetchMessages);

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    const oldest = messages.find((m) => !isPendingMessage(m));
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`${messagesUrl}?before=${encodeURIComponent(oldest.createdAt)}`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`history-${res.status}`);
      const older: ChatMessage[] = await res.json();
      setHasOlder(older.length >= CHAT_PAGE_SIZE);
      if (older.length > 0) {
        // Hold the reader's place: without this, splicing a page in above the
        // viewport throws them backwards by the height of what was added.
        const el = listRef.current;
        const distanceFromBottom = el ? el.scrollHeight - el.scrollTop : 0;
        setMessages((prev) => prependChatMessages(prev, older));
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - distanceFromBottom;
        });
      }
    } catch {
      toast.error(t("chat.history.loadFailed"));
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, messages, messagesUrl, t]);

  const sendText = useCallback(async () => {
    const text = body.trim();
    if (!text) return;
    const stagedReply = replyingTo;
    const pendingId = newPendingId();
    // Optimistic: the bubble appears the instant Enter is pressed, marked
    // "Sending" until the server confirms. The previous version cleared the
    // input and showed nothing at all until the round trip finished.
    const optimistic: ChatMessage = {
      id: pendingId,
      senderRole: myRole,
      body: text,
      replyToId: stagedReply?.id ?? null,
      replyPreview: stagedReply
        ? {
            id: stagedReply.id,
            body: stagedReply.body,
            senderRole: stagedReply.senderRole,
            kind: chatMessageKind(stagedReply),
          }
        : null,
      voiceUrl: null,
      voiceDurationMs: null,
      videoUrl: null,
      videoDurationMs: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      fileUrl: null,
      fileName: null,
      fileSizeBytes: null,
      fileMimeType: null,
      createdAt: new Date().toISOString(),
      readAt: null,
      editedAt: null,
      deletedAt: null,
      reactions: [],
    };
    setSending(true);
    setBody("");
    setReplyingTo(null);
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await fetch(messagesUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text, replyToId: stagedReply?.id ?? null }),
      });
      if (!res.ok) throw new Error(`send-${res.status}`);
      const saved: ChatMessage = await res.json();
      setMessages((prev) => replacePendingMessage(prev, pendingId, saved));
    } catch {
      // Give the draft (and the staged reply) back rather than silently losing
      // a typed message.
      setMessages((prev) => dropPendingMessage(prev, pendingId));
      setBody(text);
      setReplyingTo(stagedReply);
      toast.error(t("chat.sendFailed"));
    } finally {
      setSending(false);
    }
  }, [body, messagesUrl, myRole, replyingTo, t]);

  const replaceMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
  }, []);

  // Read via refs (not deps) so beginEdit's identity stays stable across
  // keystrokes — it is passed to memoized MessageBubble rows, and a `body`
  // dependency here would defeat that memo on every keystroke.
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const beginEdit = useCallback((m: ChatMessage) => {
    // Switching edit targets keeps the ORIGINAL draft stashed — the interim
    // edit text must not overwrite it.
    if (!editingRef.current) draftBeforeEditRef.current = bodyRef.current;
    setReplyingTo(null);
    setBody(m.body ?? "");
    setEditing(m);
    textareaRef.current?.focus();
  }, []);

  const beginReply = useCallback((m: ChatMessage) => {
    setEditing(null);
    setReplyingTo(m);
    textareaRef.current?.focus();
  }, []);

  const cancelReply = useCallback(() => setReplyingTo(null), []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setBody(draftBeforeEditRef.current);
    draftBeforeEditRef.current = "";
  }, []);

  const submitEdit = useCallback(async () => {
    if (!editing) return;
    const text = body.trim();
    if (!text) return;
    setSending(true);
    try {
      const res = await fetch(`${messagesUrl}/${editing.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) throw new Error(`edit-${res.status}`);
      const msg: ChatMessage = await res.json();
      replaceMessage(msg);
      setEditing(null);
      setBody(draftBeforeEditRef.current);
      draftBeforeEditRef.current = "";
    } catch {
      toast.error(t("chat.edit.failed"));
    } finally {
      setSending(false);
    }
  }, [editing, body, messagesUrl, replaceMessage, t]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`${messagesUrl}/${deleteTarget.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`delete-${res.status}`);
      const msg: ChatMessage = await res.json();
      replaceMessage(msg);
      // Deleting the message currently being edited must exit edit mode too.
      if (editing?.id === msg.id) cancelEdit();
      setDeleteTarget(null);
    } catch {
      toast.error(t("chat.delete.failed"));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, messagesUrl, replaceMessage, editing, cancelEdit, t]);

  const onMicPress = useCallback(async () => {
    if (isRecording) return;
    const granted = await startVoice();
    // A toast, not `alert()` — a modal browser dialog in the middle of a chat
    // is jarring and unstyleable, and every other failure here is a toast.
    if (!granted) toast.error(t("chat.voice.permissionDenied"));
  }, [isRecording, startVoice, t]);

  const sendVoice = useCallback(async () => {
    const result = await stopVoice();
    if (!result) return;
    // Voice/video/image/file sends don't carry a reply target yet (the first
    // cut is text-only) — clear any staged reply so the strip doesn't linger
    // implying an attachment was sent as that reply.
    setReplyingTo(null);
    setSending(true);
    try {
      const msg = await uploadPresignedMedia(voiceUrl, result.blob, result.mimeType, {
        durationMs: result.durationMs,
      });
      setMessages((prev) => [...prev, msg]);
    } catch {
      toast.error(t("web.chatRoom.voiceSendFailed"));
    } finally {
      setSending(false);
    }
  }, [stopVoice, voiceUrl, t]);

  const onCameraPress = useCallback(async () => {
    if (isRecording) return;
    const granted = await startVideo();
    if (!granted) toast.error(t("web.chatRoom.cameraPermissionDenied"));
  }, [isRecording, startVideo, t]);

  const sendVideo = useCallback(async () => {
    const result = await stopVideo();
    if (!result) return;
    setReplyingTo(null);
    setSending(true);
    try {
      const msg = await uploadPresignedMedia(videoUploadUrl, result.blob, result.mimeType, {
        durationMs: result.durationMs,
      });
      setMessages((prev) => [...prev, msg]);
    } catch {
      toast.error(t("web.chatRoom.videoSendFailed"));
    } finally {
      setSending(false);
    }
  }, [stopVideo, videoUploadUrl, t]);

  const sendImageFile = useCallback(
    async (file: File) => {
      setAttachOpen(false);
      setReplyingTo(null);
      setSending(true);
      try {
        const { width, height } = await readImageDimensions(file);
        const msg = await uploadPresignedMedia(imageUploadUrl, file, file.type, { width, height });
        setMessages((prev) => [...prev, msg]);
      } catch {
        toast.error(t("chat.attach.imageSendFailed"));
      } finally {
        setSending(false);
      }
    },
    [imageUploadUrl, t],
  );

  const sendDocumentFile = useCallback(
    async (file: File) => {
      setAttachOpen(false);
      setReplyingTo(null);
      setSending(true);
      try {
        const msg = await uploadPresignedMedia(
          fileUploadUrl,
          file,
          file.type || "application/octet-stream",
          { fileName: file.name, sizeBytes: file.size, mimeType: file.type },
        );
        setMessages((prev) => [...prev, msg]);
      } catch {
        toast.error(t("chat.attach.fileSendFailed"));
      } finally {
        setSending(false);
      }
    },
    [fileUploadUrl, t],
  );

  const sendReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (messageId.length === 0 || isPendingMessage({ id: messageId })) return;
      try {
        const res = await fetch(`${messagesUrl}/${messageId}/reactions`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emoji }),
        });
        if (!res.ok) throw new Error(`react-${res.status}`);
        const msg: ChatMessage = await res.json();
        replaceMessage(msg);
      } catch {
        toast.error(t("chat.react.failed"));
      }
    },
    [messagesUrl, replaceMessage, t],
  );

  // Stable per-row handlers passed to memoized MessageBubble rows — identity
  // never changes across renders, so typing in the composer doesn't defeat the
  // memo for every bubble.
  const onRowMenuToggle = useCallback(
    (id: string, open: boolean) => setMenuFor(open ? id : null),
    [],
  );
  const onRowOpenEmojiPicker = useCallback(
    (id: string) => setEmojiTarget({ kind: "message", id }),
    [],
  );

  const copyMessage = useCallback(
    async (message: ChatMessage) => {
      try {
        await navigator.clipboard.writeText(messageToClipboardText(message, t));
        toast.success(t("chat.actions.copied"));
      } catch {
        toast.error(t("chat.selection.copyFailed"));
      }
    },
    [t],
  );

  const insertEmoji = useCallback((emoji: string) => {
    const el = textareaRef.current;
    if (!el) {
      setBody((current) => current + emoji);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setBody((current) => current.slice(0, start) + emoji + current.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + emoji.length;
    });
  }, []);

  const onEmojiChosen = useCallback(
    (emoji: string) => {
      if (!emojiTarget) return;
      if (emojiTarget.kind === "composer") insertEmoji(emoji);
      else sendReaction(emojiTarget.id, emoji);
      setEmojiTarget(null);
    },
    [emojiTarget, insertEmoji, sendReaction],
  );

  const beginSelection = useCallback((id: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  }, []);

  const cancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectionMode && selectedIds.size === 0) setSelectionMode(false);
  }, [selectionMode, selectedIds]);

  const selectedMessages = useMemo(
    () => messages.filter((m) => selectedIds.has(m.id)),
    [messages, selectedIds],
  );

  const copySelected = useCallback(async () => {
    const text = selectedMessages.map((m) => messageToClipboardText(m, t)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("chat.selection.copied"));
    } catch {
      toast.error(t("chat.selection.copyFailed"));
    }
    cancelSelection();
  }, [selectedMessages, t, cancelSelection]);

  const canDeleteSelected =
    selectedMessages.length > 0 &&
    selectedMessages.every((m) => canDeleteChatMessage(m, myRole, Date.now()));

  const confirmBulkDelete = useCallback(async () => {
    setBulkDeleting(true);
    for (const id of selectedIds) {
      try {
        const res = await fetch(`${messagesUrl}/${id}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (res.ok) {
          const msg: ChatMessage = await res.json();
          replaceMessage(msg);
        }
      } catch {
        // Best effort per message — continue with the rest.
      }
    }
    setBulkDeleting(false);
    setBulkDeleteOpen(false);
    cancelSelection();
  }, [selectedIds, messagesUrl, replaceMessage, cancelSelection]);

  const days = useMemo(() => groupRowsByDay(buildChatRows(messages)), [messages]);
  const isEmpty = messages.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selectionMode && (
        <div className="border-border bg-muted flex shrink-0 items-center gap-2 border-b px-3 py-2 lg:px-4">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={cancelSelection}
            aria-label={t("chat.selection.cancel")}
          >
            <X className="h-4 w-4" />
          </Button>
          <span aria-live="polite" className="flex-1 text-sm font-medium">
            {t("chat.selection.count", { count: selectedIds.size })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={copySelected}
            aria-label={t("chat.selection.copy")}
          >
            <Copy className="h-4 w-4" />
          </Button>
          {canDeleteSelected && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setBulkDeleteOpen(true)}
              aria-label={t("chat.selection.delete")}
            >
              <Trash2 className="text-destructive h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {/* The list and its floating "jump to latest" share a positioning
          context, so the pill sits just above the composer rather than on it. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          onScroll={onListScroll}
          // `log` announces arrivals; `tabIndex` is what makes a scrollable
          // region reachable without a mouse (WCAG 2.1.1). Neither was here.
          role="log"
          aria-label={t("chat.list.label")}
          tabIndex={0}
          // `flex flex-col` exists for the `mt-auto` on the content below it:
          // a short conversation belongs at the BOTTOM of the pane, growing up
          // out of the composer, not stranded at the top of it with a screen
          // of empty ground underneath. `mt-auto` is the safe half of that
          // idiom — it collapses to zero once the content is taller than the
          // pane, where `justify-end` would clip the oldest message instead.
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 lg:px-6"
        >
          {isEmpty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <PersonAvatar name={peerName} photoUrl={peerPhotoUrl} size={56} />
              <p className="text-foreground font-bold">{t("chat.empty.title")}</p>
              <p className="text-muted-foreground max-w-prose text-sm">
                {t(myRole === "student" ? "chat.empty.student" : "chat.empty.teacher")}
              </p>
            </div>
          ) : (
            /* The bubbles are capped to a reading column and centred inside
               the pane. Without it a 1600px window stretched `max-w-bubble`'s
               72% into a 90-character line, which is a document, not a
               message — and put the two speakers so far apart that a reply
               was across the desk from what it answered. */
            <div className="mx-auto mt-auto w-full max-w-3xl">
              <div className="mb-2 flex justify-center">
                {hasOlder ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={loadOlder}
                    disabled={loadingOlder}
                    className="rounded-full"
                  >
                    {loadingOlder ? t("chat.history.loading") : t("chat.history.loadOlder")}
                  </Button>
                ) : (
                  <div className="flex flex-col items-center gap-2 px-6 py-4 text-center">
                    <PersonAvatar name={peerName} photoUrl={peerPhotoUrl} size={56} />
                    <p className="text-foreground font-bold">{peerName}</p>
                    <p className="text-muted-foreground text-sm">{t("chat.history.start")}</p>
                  </div>
                )}
              </div>
              {days.map((day) => {
                const label = dayDividerLabel(day.rows[0].message.createdAt, t, locale);
                return (
                  <section key={day.key} aria-label={label}>
                    {/* Sticky within its own day, so the date you are reading
                      stays named for as long as you are inside it. */}
                    <div className="sticky top-0 z-20 flex justify-center py-2">
                      <span className="border-border bg-muted text-muted-foreground shadow-brand-sm rounded-full border px-3 py-1 text-sm font-medium">
                        {label}
                      </span>
                    </div>
                    {day.rows.map(({ message, startsRun, endsRun }) => (
                      <MessageBubble
                        key={message.id}
                        message={message}
                        myRole={myRole}
                        peerName={peerName}
                        locale={locale}
                        t={t}
                        startsRun={startsRun}
                        endsRun={endsRun}
                        menuOpen={menuFor === message.id}
                        selectionMode={selectionMode}
                        selected={selectedIds.has(message.id)}
                        onMenuToggle={onRowMenuToggle}
                        onReact={sendReaction}
                        onOpenEmojiPicker={onRowOpenEmojiPicker}
                        onReply={beginReply}
                        onEdit={beginEdit}
                        onDelete={setDeleteTarget}
                        onCopy={copyMessage}
                        onSelect={beginSelection}
                        onToggleSelected={toggleSelected}
                      />
                    ))}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        {!followingLatest && !isEmpty && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={jumpToLatest}
              className="animate-fade-in-up shadow-brand-lg pointer-events-auto rounded-full"
            >
              <ArrowDown className="h-4 w-4" />
              {unseen > 0 ? t("chat.jump.newCount", { count: unseen }) : t("chat.jump.latest")}
            </Button>
          </div>
        )}
      </div>

      {!selectionMode && (
        <ChatComposer
          t={t}
          value={body}
          onChange={setBody}
          onSubmit={editing ? submitEdit : sendText}
          sending={sending}
          textareaRef={textareaRef}
          editing={editing}
          onCancelEdit={cancelEdit}
          replyingTo={replyingTo}
          onCancelReply={cancelReply}
          onSendImage={sendImageFile}
          onSendDocument={sendDocumentFile}
          onOpenEmoji={() => setEmojiTarget({ kind: "composer" })}
          attachOpen={attachOpen}
          onAttachOpenChange={setAttachOpen}
          voice={{
            recording: voiceRecorderState === "recording",
            elapsedMs: voiceElapsedMs,
            onStart: onMicPress,
            onCancel: cancelVoice,
            onSend: sendVoice,
          }}
          video={{
            recording: videoRecorderState === "recording",
            elapsedMs: videoElapsedMs,
            onStart: onCameraPress,
            onCancel: cancelVideo,
            onSend: sendVideo,
          }}
          videoPreviewRef={previewRef}
        />
      )}

      <EmojiPickerDialog
        open={emojiTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEmojiTarget(null);
        }}
        onSelect={onEmojiChosen}
        t={t}
      />

      {/* Delete-for-everyone confirmation */}
      <ConfirmDialog
        trigger={<span className="hidden" aria-hidden />}
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("chat.delete.confirmTitle")}
        description={t("chat.delete.confirmBody")}
        footer={(close) => (
          <>
            <Button type="button" variant="outline" onClick={close} disabled={deleting}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {t("chat.delete.confirm")}
            </Button>
          </>
        )}
      />

      {/* Bulk delete-for-everyone confirmation */}
      <ConfirmDialog
        trigger={<span className="hidden" aria-hidden />}
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={t("chat.delete.confirmTitle")}
        description={t("chat.delete.confirmBody")}
        footer={(close) => (
          <>
            <Button type="button" variant="outline" onClick={close} disabled={bulkDeleting}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmBulkDelete}
              disabled={bulkDeleting}
            >
              {t("chat.delete.confirm")}
            </Button>
          </>
        )}
      />
    </div>
  );
}
