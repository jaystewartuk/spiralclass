"use client";

import { memo } from "react";
import {
  Ban,
  Check,
  CheckCheck,
  CheckSquare,
  Clock3,
  Copy,
  MoreVertical,
  Pencil,
  Reply,
  Smile,
  Square,
  Trash2,
} from "lucide-react";
import type { AppLocale, ChatMessage, TFunction } from "@spiralclass/shared";
import { QUICK_REACTIONS, canDeleteChatMessage, canEditChatMessage } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { ChatMenuItem, ChatPopover } from "@/components/chat/chat-popover";
import { FileMessage } from "@/components/chat/file-message";
import { ImageMessage } from "@/components/chat/image-message";
import { VideoMessage } from "@/components/chat/video-message";
import { VoiceMessage } from "@/components/chat/voice-message";
import {
  chatMessageKind,
  formatMessageDateTime,
  formatMessageTime,
  isEmojiOnly,
  replyPreviewText,
} from "@/lib/chat/labels";
import { isPendingMessage } from "@/lib/chat/view-model";
import { cn } from "@/lib/utils";

/**
 * Corner geometry for a bubble inside a run of consecutive messages from one
 * sender. The sender's own side keeps a large radius at the ends of the run
 * and tightens in the middle, so three messages read as one block of speech
 * with a single tail — the shape that tells you at a glance where one person
 * stopped talking and the other started.
 */
export function bubbleCorners(fromMe: boolean, startsRun: boolean, endsRun: boolean): string {
  if (fromMe) {
    return cn(
      "rounded-2xl",
      !startsRun && "rounded-tr-md",
      endsRun ? "rounded-br-sm" : "rounded-br-md",
    );
  }
  return cn(
    "rounded-2xl",
    !startsRun && "rounded-tl-md",
    endsRun ? "rounded-bl-sm" : "rounded-bl-md",
  );
}

/** The bubble's fill. Media sits on the neutral card so a photo is never tinted
 * by the brand colour behind it; text and voice take the sender's own fill. */
function bubbleSurface(fromMe: boolean, tinted: boolean): string {
  if (!tinted) return "bg-card border-border text-foreground border";
  return fromMe
    ? "bg-primary text-primary-foreground"
    : "bg-card border-border text-foreground border";
}

/**
 * Delivery state, shown once per run beside the timestamp.
 *
 * It carries a word as well as a shape (D-140: status is never hue alone) —
 * previously both check marks were `aria-hidden`, so the entire sent/read
 * distinction was invisible to a screen reader. The double check is also no
 * longer drawn in `--info` on top of `--primary`, a teal-on-blue pairing that
 * did not clear contrast in either theme; the whole meta row now sits outside
 * the bubble on the page ground.
 */
function DeliveryStatus({ message, t }: { message: ChatMessage; t: TFunction }) {
  const state = isPendingMessage(message) ? "sending" : message.readAt ? "read" : "sent";
  const label = t(
    state === "sending"
      ? "chat.status.sending"
      : state === "read"
        ? "chat.status.read"
        : "chat.status.sent",
  );
  const Icon = state === "sending" ? Clock3 : state === "read" ? CheckCheck : Check;
  return (
    <span className="inline-flex items-center gap-1" title={label}>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", state === "read" && "text-info")} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The quoted message a reply points at. */
function QuotedSnippet({
  preview,
  fromMe,
  t,
}: {
  preview: ChatMessage["replyPreview"];
  fromMe: boolean;
  t: TFunction;
}) {
  if (!preview) return null;
  return (
    <div
      className={cn(
        "mb-1.5 rounded-md border-l-2 px-2 py-1 text-sm",
        fromMe
          ? "border-primary-foreground bg-overlay-1 text-primary-foreground"
          : "border-primary bg-muted text-muted-foreground",
      )}
    >
      <p className="truncate">{replyPreviewText(preview, t)}</p>
    </div>
  );
}

function ReactionPills({
  reactions,
  myRole,
  fromMe,
  t,
  onPick,
}: {
  reactions: ChatMessage["reactions"];
  myRole: "teacher" | "student";
  fromMe: boolean;
  t: TFunction;
  onPick: (emoji: string) => void;
}) {
  if (reactions.length === 0) return null;
  return (
    // Tucked onto the bubble's bottom edge rather than parked on a row of its
    // own: a reaction belongs to the message, and a separate line made every
    // reacted message a third taller.
    <div
      className={cn(
        "relative z-10 -mt-2 flex gap-1",
        fromMe ? "justify-end pr-2" : "justify-start pl-2",
      )}
    >
      {reactions.map((reaction) => {
        const mine = reaction.role === myRole;
        return (
          <Button
            key={reaction.role}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPick(reaction.emoji)}
            aria-label={t(mine ? "chat.reaction.yours" : "chat.reaction.theirs", {
              emoji: reaction.emoji,
            })}
            className={cn(
              "h-7 rounded-full bg-card px-2 text-base leading-none shadow-brand-sm lg:h-7",
              mine && "border-primary",
            )}
          >
            <span aria-hidden>{reaction.emoji}</span>
          </Button>
        );
      })}
    </div>
  );
}

export type MessageBubbleProps = {
  message: ChatMessage;
  myRole: "teacher" | "student";
  /** The other party's display name, for the screen-reader-only sender label
   * that opens each run — a chat log that never says who is talking is close
   * to useless read aloud. */
  peerName: string;
  locale: AppLocale;
  t: TFunction;
  startsRun: boolean;
  endsRun: boolean;
  menuOpen: boolean;
  selectionMode: boolean;
  selected: boolean;
  onMenuToggle: (id: string, open: boolean) => void;
  onReact: (id: string, emoji: string) => void;
  onOpenEmojiPicker: (id: string) => void;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onDelete: (message: ChatMessage) => void;
  onCopy: (message: ChatMessage) => void;
  onSelect: (id: string) => void;
  onToggleSelected: (id: string) => void;
};

export const MessageBubble = memo(function MessageBubble({
  message,
  myRole,
  peerName,
  locale,
  t,
  startsRun,
  endsRun,
  menuOpen,
  selectionMode,
  selected,
  onMenuToggle,
  onReact,
  onOpenEmojiPicker,
  onReply,
  onEdit,
  onDelete,
  onCopy,
  onSelect,
  onToggleSelected,
}: MessageBubbleProps) {
  const fromMe = message.senderRole === myRole;
  const messageId = message.id;
  const pending = isPendingMessage(message);
  const kind = chatMessageKind(message);
  // Only a photo or a clip we can actually SHOW gets the flush media shell.
  // A message whose signed URL failed to mint still has its kind, and an empty
  // 4px frame would be worse than the text fallback below.
  const isMedia =
    (kind === "image" && message.imageUrl !== null) ||
    (kind === "video" && message.videoUrl !== null);
  /**
   * A few emoji and nothing else: drawn large and bare, the way every
   * messaging app people already use draws them. A quoted reply keeps its
   * bubble — the quote is the context the emoji answers, and it needs a
   * surface to sit on.
   */
  const jumboEmoji =
    !message.deletedAt && kind === "text" && !message.replyPreview && isEmojiOnly(message.body);
  const now = Date.now();
  const canEdit = !pending && fromMe && canEditChatMessage(message, myRole, now);
  const canDelete = !pending && fromMe && canDeleteChatMessage(message, myRole, now);

  const handleToggleSelected = () => onToggleSelected(messageId);
  const rowClick = selectionMode ? handleToggleSelected : undefined;

  const checkbox = selectionMode ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={handleToggleSelected}
      aria-label={t("chat.select")}
      aria-pressed={selected}
      className="shrink-0 self-center text-muted-foreground"
    >
      {selected ? <CheckSquare className="h-5 w-5 text-primary" /> : <Square className="h-5 w-5" />}
    </Button>
  ) : null;

  // One trigger per message rather than three hover-only 24px icons. The old
  // cluster was unreachable on a phone at a usable size and unlabelled to a
  // screen reader; a single menu is one target, keyboard-navigable, and holds
  // every action including the reaction row.
  const actions =
    selectionMode || pending ? (
      <div className="w-11 shrink-0 lg:w-10" aria-hidden />
    ) : (
      <div
        className={cn(
          "w-11 shrink-0 self-center lg:w-10",
          "opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
          menuOpen && "opacity-100",
          "[@media(pointer:coarse)]:opacity-100",
        )}
      >
        <ChatPopover
          open={menuOpen}
          onOpenChange={(open) => onMenuToggle(messageId, open)}
          label={t("web.chatRoom.messageActions")}
          icon={<MoreVertical className="h-4 w-4" />}
          align={fromMe ? "left" : "right"}
          panelClassName="w-64"
          triggerClassName="text-muted-foreground hover:text-foreground rounded-full"
        >
          {(close) => (
            <>
              <div className="grid grid-cols-6 gap-0.5 pb-1">
                {QUICK_REACTIONS.map((emoji) => (
                  <Button
                    key={emoji}
                    type="button"
                    data-chat-menu-item
                    role="menuitem"
                    tabIndex={-1}
                    variant="ghost"
                    onClick={() => {
                      close();
                      onReact(messageId, emoji);
                    }}
                    aria-label={emoji}
                    className="h-11 w-full px-0 text-xl lg:h-10"
                  >
                    <span aria-hidden>{emoji}</span>
                  </Button>
                ))}
              </div>
              <div className="-mx-1 mb-1 border-t border-border" />
              <ChatMenuItem
                icon={<Smile className="h-4 w-4" />}
                label={t("chat.react.more")}
                onSelect={() => {
                  close();
                  onOpenEmojiPicker(messageId);
                }}
              />
              <ChatMenuItem
                icon={<Reply className="h-4 w-4" />}
                label={t("chat.reply.action")}
                onSelect={() => {
                  close();
                  onReply(message);
                }}
              />
              <ChatMenuItem
                icon={<Copy className="h-4 w-4" />}
                label={t("chat.actions.copy")}
                onSelect={() => {
                  close();
                  onCopy(message);
                }}
              />
              {canEdit && (
                <ChatMenuItem
                  icon={<Pencil className="h-4 w-4" />}
                  label={t("chat.actions.edit")}
                  onSelect={() => {
                    close();
                    onEdit(message);
                  }}
                />
              )}
              <ChatMenuItem
                icon={<CheckSquare className="h-4 w-4" />}
                label={t("chat.select")}
                onSelect={() => {
                  close();
                  onSelect(messageId);
                }}
              />
              {canDelete && (
                <ChatMenuItem
                  icon={<Trash2 className="h-4 w-4" />}
                  label={t("chat.actions.delete")}
                  tone="destructive"
                  onSelect={() => {
                    close();
                    onDelete(message);
                  }}
                />
              )}
            </>
          )}
        </ChatPopover>
      </div>
    );

  let content: React.ReactNode;
  if (message.deletedAt) {
    content = (
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Ban className="h-4 w-4 shrink-0" aria-hidden />
        {fromMe ? t("chat.deleted.byMe") : t("chat.deleted.byThem")}
      </p>
    );
  } else if (message.videoUrl) {
    content = <VideoMessage videoUrl={message.videoUrl} t={t} />;
  } else if (message.imageUrl) {
    content = (
      <ImageMessage
        imageUrl={message.imageUrl}
        width={message.imageWidth}
        height={message.imageHeight}
        t={t}
      />
    );
  } else if (message.voiceUrl) {
    content = (
      <VoiceMessage
        voiceUrl={message.voiceUrl}
        durationMs={message.voiceDurationMs}
        fromMe={fromMe}
        t={t}
      />
    );
  } else if (message.fileUrl) {
    content = (
      <FileMessage
        fileUrl={message.fileUrl}
        fileName={message.fileName}
        sizeBytes={message.fileSizeBytes}
        fromMe={fromMe}
        locale={locale}
        t={t}
      />
    );
  } else {
    // text-base, not text-sm: a message body IS body text, and D-140 puts the
    // floor for that at 17px. It also restores the hierarchy the meta row lost
    // when both were sized the same.
    content = (
      <p
        className={cn(
          "break-words whitespace-pre-wrap",
          jumboEmoji ? "text-4xl leading-tight" : "text-base",
        )}
      >
        {message.body}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-end gap-1",
        fromMe ? "justify-end" : "justify-start",
        startsRun ? "mt-4 first:mt-0" : "mt-0.5",
        // A tucked reaction pill hangs below the bubble; without this it
        // collides with the next message in the run.
        message.reactions.length > 0 && "mb-2",
      )}
    >
      {selectionMode && !fromMe && checkbox}
      {fromMe && actions}
      <div
        className={cn("max-w-bubble min-w-0", selectionMode && "cursor-pointer")}
        onClick={rowClick}
      >
        {startsRun && <p className="sr-only">{fromMe ? t("chat.you") : peerName}</p>}
        <div
          className={cn(
            jumboEmoji
              ? "px-1 py-0.5"
              : cn(
                  bubbleCorners(fromMe, startsRun, endsRun),
                  message.deletedAt
                    ? "border border-border bg-muted text-muted-foreground"
                    : bubbleSurface(fromMe, !isMedia),
                  isMedia ? "max-w-attachment overflow-hidden p-1" : "px-3.5 py-2.5",
                ),
            selected && "ring-3 ring-ring ring-offset-2 ring-offset-background",
            pending && "opacity-70",
          )}
        >
          {!message.deletedAt && (
            <QuotedSnippet preview={message.replyPreview} fromMe={fromMe} t={t} />
          )}
          {content}
        </div>
        <ReactionPills
          reactions={message.reactions}
          myRole={myRole}
          fromMe={fromMe}
          t={t}
          onPick={(emoji) => onReact(messageId, emoji)}
        />
        {/* The meta row lives OUTSIDE the bubble, and only on the last message
            of a run: quiet on the page ground instead of competing with the
            body text it used to sit beside at the same size. */}
        <p
          className={cn(
            "mt-1 flex items-center gap-1.5 text-sm text-muted-foreground",
            fromMe ? "justify-end" : "justify-start",
            !endsRun && "sr-only",
          )}
        >
          {/* The visible label is the wall-clock time; the full date is one
              hover away, because "10:36" alone does not say which day once you
              have scrolled past the divider that did. */}
          <time
            dateTime={message.createdAt}
            title={formatMessageDateTime(message.createdAt, locale)}
          >
            {formatMessageTime(message.createdAt, locale)}
          </time>
          {message.editedAt && !message.deletedAt ? (
            <span>{t("chat.edit.editedLabel")}</span>
          ) : null}
          {fromMe && <DeliveryStatus message={message} t={t} />}
        </p>
      </div>
      {!fromMe && actions}
      {selectionMode && fromMe && checkbox}
    </div>
  );
});
