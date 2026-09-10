"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Check,
  FileText,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Pencil,
  Reply,
  Send,
  Smile,
  Video,
  X,
} from "lucide-react";
import type { ChatMessage, TFunction } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatMenuItem, ChatPopover } from "@/components/chat/chat-popover";
import { chatMessageKind, replyPreviewText } from "@/lib/chat/labels";
import { formatElapsed } from "@/lib/chat/view-model";

/** The composer grows with the draft up to this height, then scrolls. */
const MAX_COMPOSER_HEIGHT_PX = 128;

type RecorderControls = {
  recording: boolean;
  elapsedMs: number;
  onStart: () => void;
  onCancel: () => void;
  onSend: () => void;
};

/** A live recording: the elapsed clock, a cancel and a send. */
function RecordingBar({
  label,
  elapsedMs,
  sending,
  onCancel,
  onSend,
  cancelLabel,
  sendLabel,
  t,
}: {
  label: string;
  elapsedMs: number;
  sending: boolean;
  onCancel: () => void;
  onSend: () => void;
  cancelLabel: string;
  sendLabel: string;
  t: TFunction;
}) {
  return (
    <div className="flex items-center gap-3" role="status">
      <span
        aria-hidden
        className="bg-destructive h-2.5 w-2.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none"
      />
      <span className="text-foreground flex-1 text-sm font-medium">
        {label} <span className="tabular-nums">{formatElapsed(elapsedMs)}</span>
      </span>
      <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label={cancelLabel}>
        <X className="h-4 w-4" />
      </Button>
      <Button type="button" disabled={sending} onClick={onSend} aria-label={sendLabel}>
        <Send className="h-4 w-4" />
        {t("chat.send")}
      </Button>
    </div>
  );
}

/** The "you are editing / replying to X" strip above the input. */
function ContextStrip({
  icon,
  title,
  preview,
  onCancel,
  cancelLabel,
}: {
  icon: React.ReactNode;
  title: string;
  preview: string;
  onCancel: () => void;
  cancelLabel: string;
}) {
  return (
    <div className="border-border bg-muted mb-2 flex items-center gap-2.5 rounded-md border px-3 py-2">
      <span className="text-primary shrink-0" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block truncate text-sm">{preview}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onCancel}
        aria-label={cancelLabel}
        className="shrink-0"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function ChatComposer({
  t,
  value,
  onChange,
  onSubmit,
  sending,
  textareaRef,
  editing,
  onCancelEdit,
  replyingTo,
  onCancelReply,
  onSendImage,
  onSendDocument,
  onOpenEmoji,
  attachOpen,
  onAttachOpenChange,
  voice,
  video,
  videoPreviewRef,
}: {
  t: TFunction;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  sending: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  editing: ChatMessage | null;
  onCancelEdit: () => void;
  replyingTo: ChatMessage | null;
  onCancelReply: () => void;
  onSendImage: (file: File) => void;
  onSendDocument: (file: File) => void;
  onOpenEmoji: () => void;
  attachOpen: boolean;
  onAttachOpenChange: (open: boolean) => void;
  voice: RecorderControls;
  video: RecorderControls;
  videoPreviewRef: RefObject<HTMLVideoElement | null>;
}) {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

  // Grow with the draft instead of scrolling a one-line box. `rows={1}` with a
  // fixed height meant a three-line message was composed through a 38px
  // window — you could not see what you had written.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`;
  }, [value, textareaRef]);

  const submitOnEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === "Escape") {
      if (editing) {
        event.preventDefault();
        onCancelEdit();
      } else if (replyingTo) {
        event.preventDefault();
        onCancelReply();
      }
    }
  };

  const hasDraft = value.trim().length > 0;
  // The keyboard hint is an answer to "what does Enter do here", which is only
  // a live question while she is typing. Shown permanently it is a line of
  // grey text under every conversation forever; its row is reserved either way
  // so revealing it never nudges the composer.
  const [focused, setFocused] = useState(false);
  const showHint = focused || hasDraft;

  return (
    <div className="pb-safe border-border bg-background shrink-0 border-t">
      {video.recording && (
        <div className="border-border bg-scrim-3 flex shrink-0 justify-center border-b p-2">
          {/* Mirrored, because a selfie preview that is not mirrored reads as
              someone else's face. */}
          <video
            ref={videoPreviewRef}
            aria-label={t("chat.video.preview")}
            className="max-h-attachment w-auto -scale-x-100 rounded-lg"
            muted
            playsInline
            autoPlay
          />
        </div>
      )}

      {/* Centred on the same column the bubbles are, so a wide pane doesn't
          leave a 48rem conversation above a 90rem input. */}
      <div className="mx-auto w-full max-w-3xl px-3 py-3 lg:px-4">
        {voice.recording ? (
          <RecordingBar
            t={t}
            label={t("chat.voice.recording")}
            elapsedMs={voice.elapsedMs}
            sending={sending}
            onCancel={voice.onCancel}
            onSend={voice.onSend}
            cancelLabel={t("chat.voice.cancel")}
            sendLabel={t("web.chatRoom.sendVoiceMessage")}
          />
        ) : video.recording ? (
          <RecordingBar
            t={t}
            label={t("web.chatRoom.recordingVideo")}
            elapsedMs={video.elapsedMs}
            sending={sending}
            onCancel={video.onCancel}
            onSend={video.onSend}
            cancelLabel={t("web.chatRoom.cancelVideo")}
            sendLabel={t("web.chatRoom.sendVideo")}
          />
        ) : (
          <>
            {editing && (
              <ContextStrip
                icon={<Pencil className="h-4 w-4" />}
                title={t("chat.edit.editing")}
                preview={editing.body ?? ""}
                onCancel={onCancelEdit}
                cancelLabel={t("web.chatRoom.cancelEdit")}
              />
            )}
            {!editing && replyingTo && (
              <ContextStrip
                icon={<Reply className="h-4 w-4" />}
                title={t("chat.reply.composerTitle")}
                preview={replyPreviewText(
                  {
                    id: replyingTo.id,
                    body: replyingTo.body,
                    senderRole: replyingTo.senderRole,
                    kind: chatMessageKind(replyingTo),
                  },
                  t,
                )}
                onCancel={onCancelReply}
                cancelLabel={t("chat.reply.cancel")}
              />
            )}

            <div className="flex items-end gap-1.5">
              {!editing && (
                <>
                  {/* One attachment menu instead of three separate outlined
                      boxes. Four controls plus the input did not fit a phone,
                      and every one of them was a 36px target. */}
                  <ChatPopover
                    open={attachOpen}
                    onOpenChange={onAttachOpenChange}
                    label={t("chat.composer.attachments")}
                    icon={<Paperclip className="h-5 w-5" />}
                    align="left"
                    panelClassName="w-56"
                    triggerClassName="text-muted-foreground hover:text-foreground shrink-0"
                  >
                    {(close) => (
                      <>
                        <ChatMenuItem
                          icon={<ImageIcon className="h-4 w-4" />}
                          label={t("chat.attach.photo")}
                          onSelect={() => {
                            close();
                            photoInputRef.current?.click();
                          }}
                        />
                        <ChatMenuItem
                          icon={<ImageIcon className="h-4 w-4" />}
                          label={t("chat.attach.takePhoto")}
                          onSelect={() => {
                            close();
                            cameraInputRef.current?.click();
                          }}
                        />
                        <ChatMenuItem
                          icon={<Video className="h-4 w-4" />}
                          label={t("chat.video.record")}
                          onSelect={() => {
                            close();
                            video.onStart();
                          }}
                        />
                        <ChatMenuItem
                          icon={<FileText className="h-4 w-4" />}
                          label={t("chat.attach.document")}
                          onSelect={() => {
                            close();
                            documentInputRef.current?.click();
                          }}
                        />
                      </>
                    )}
                  </ChatPopover>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={onOpenEmoji}
                    aria-label={t("web.chatRoom.emojiPicker")}
                    className="text-muted-foreground hover:text-foreground hidden shrink-0 lg:inline-flex"
                  >
                    <Smile className="h-5 w-5" />
                  </Button>
                </>
              )}

              <Textarea
                ref={textareaRef}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={submitOnEnter}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={t("chat.placeholder")}
                aria-label={t("chat.composer.label")}
                rows={1}
                className="max-h-32 min-h-11 resize-none rounded-2xl px-4 py-2.5 text-base lg:min-h-11 lg:text-base"
              />

              {/* WhatsApp's morphing action: the microphone occupies the send
                  slot until there is something to send, so an empty composer
                  still offers its most-used control and the row never carries
                  a permanently disabled button. */}
              {hasDraft || editing ? (
                <Button
                  type="button"
                  size="icon"
                  className="shrink-0 rounded-full"
                  disabled={!hasDraft || sending}
                  onClick={onSubmit}
                  aria-label={editing ? t("web.chatRoom.saveEdit") : t("web.chatRoom.sendMessage")}
                >
                  {editing ? <Check className="h-5 w-5" /> : <Send className="h-5 w-5" />}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="shrink-0 rounded-full"
                  onClick={voice.onStart}
                  aria-label={t("chat.voice.record")}
                >
                  <Mic className="h-5 w-5" />
                </Button>
              )}
            </div>

            <p className="text-muted-foreground mt-2 hidden min-h-5 text-sm lg:block">
              {showHint ? t("chat.composer.hint") : null}
            </p>
          </>
        )}
      </div>

      {/* Hidden inputs backing the attachment menu. */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onSendImage(file);
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onSendImage(file);
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onSendDocument(file);
        }}
      />
    </div>
  );
}
