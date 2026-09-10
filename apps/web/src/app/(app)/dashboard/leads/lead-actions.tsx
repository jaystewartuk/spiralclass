"use client";

import { useActionState } from "react";
import {
  Archive,
  ArchiveRestore,
  Mail,
  MailCheck,
  MessageCircle,
  Undo2,
  UserCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { setLeadStatus, type LeadStatusState } from "@/app/actions/leads";
import { mailtoHref, whatsappHref } from "@/lib/leads/list";

type LeadStatusValue = "new" | "contacted" | "converted" | "archived";

/**
 * Everything a teacher can do to one lead: reach the person, and record what
 * happened.
 *
 * TWO GROUPS, NOT ONE ROW OF BUTTONS. Replying is the job; the status is
 * bookkeeping about the job. The previous version had them as one undifferen-
 * tiated row in which "Mark converted" was a solid primary button on every
 * card — so the loudest control on a screen full of people waiting to hear
 * back was the one that files them away. Contact leads, at full weight;
 * the lifecycle controls are quiet and sit behind a group label.
 *
 * THE LIFECYCLE CONTROLS ARE A REAL FORM, deliberately. One form with several
 * submit buttons, each carrying its target status in `value` — the clicked
 * button is the one whose value reaches the action — so every transition works
 * with JavaScript off. Only the transitions that make sense from the current
 * status are rendered, including the one back out of `converted`, which had no
 * way back before: a mis-click was permanent short of archiving the row.
 *
 * REPLYING MARKS THE LEAD CONTACTED. A pipeline where the state has to be
 * updated by hand after every reply is a pipeline that is wrong by the second
 * week, and "did I answer this one?" is the entire question this screen exists
 * to answer. So opening the mail client or WhatsApp on a `new` lead files it
 * as contacted at the same time. Two things make that safe rather than
 * presumptuous: it is announced, and it is undoable in the same breath — a
 * toast rather than an inline note, because the card itself moves from "Needs
 * a reply" to "In conversation" as a result, and an inline undo would be
 * unmounted by the move it is offering to reverse. With JavaScript off the
 * link still opens the mail client and simply does not file anything, which is
 * the old behaviour rather than a broken one.
 */
export function LeadActions({
  leadId,
  status,
  name,
  email,
  phoneE164,
  replySubject,
}: {
  leadId: string;
  status: LeadStatusValue;
  name: string;
  email: string;
  phoneE164: string | null;
  /** Written in the language of her BOOKING PAGE, not her dashboard — the
   * person receiving this reply read the page, not the app. Resolved by the
   * page, which is where the teacher row is. */
  replySubject: string;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<LeadStatusState, FormData>(
    setLeadStatus,
    undefined,
  );

  const payload = (next: LeadStatusValue) => {
    const data = new FormData();
    data.set("leadId", leadId);
    data.set("status", next);
    return data;
  };

  // Fired when she opens a reply. The undo calls the server action directly
  // rather than through `formAction`: by the time the toast is clicked this
  // component may have been unmounted by the very move it is undoing, and a
  // dispatch into an unmounted hook is a no-op.
  const onContact = () => {
    if (status !== "new") return;
    formAction(payload("contacted"));
    toast.success(t("web.dashboard.leads.autoContacted", { name }), {
      action: {
        label: t("web.dashboard.leads.undo"),
        // The result is reported rather than assumed: an undo that silently
        // failed would leave her believing the lead is back in "Needs a
        // reply" when it is not, which is worse than the auto-filing this
        // undoes.
        onClick: () => {
          setLeadStatus(undefined, payload("new"))
            .then((result) => {
              if (result?.error) toast.error(result.error);
            })
            .catch(() => toast.error(t("common.error")));
        },
      },
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {/* Absent on an archived lead rather than merely quiet. Archiving is
          how she says she is done with someone; offering to write to them
          anyway is the interface arguing with the decision she just made.
          Restoring brings the contact buttons back with the lead. */}
      {status !== "archived" && (
        <div
          role="group"
          aria-label={t("web.dashboard.leads.contactLabel")}
          className="flex flex-wrap items-center gap-2"
        >
          {/* Primary only where replying IS the next step. On a lead she has
              already answered, a solid button on every row would make the page
              a column of blue rectangles and stop meaning "do this one". */}
          <Button asChild size="sm" variant={status === "new" ? "default" : "outline"}>
            <a
              href={mailtoHref(email, replySubject)}
              onClick={onContact}
              aria-label={t("web.dashboard.leads.replyAria", { name })}
            >
              <Mail className="size-4" aria-hidden />
              {t("web.dashboard.leads.reply")}
            </a>
          </Button>
          {phoneE164 && (
            <Button asChild size="sm" variant={status === "new" ? "outline" : "ghost"}>
              <a
                href={whatsappHref(phoneE164)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onContact}
                aria-label={t("web.dashboard.leads.whatsappAria", { name })}
              >
                <MessageCircle className="size-4" aria-hidden />
                {t("web.dashboard.leads.whatsapp")}
              </a>
            </Button>
          )}
        </div>
      )}

      <form
        action={formAction}
        aria-label={t("web.dashboard.leads.statusLabel")}
        className="flex flex-wrap items-center gap-1"
      >
        <input type="hidden" name="leadId" value={leadId} />
        {status === "new" && (
          <StatusButton
            value="contacted"
            label={t("web.dashboard.leads.markContacted")}
            aria={t("web.dashboard.leads.markContactedAria", { name })}
            icon={MailCheck}
            pending={pending}
          />
        )}
        {/* The way back out of `converted`, which had none: before this a
            mis-click was permanent short of archiving the row. Named "Reopen"
            rather than reusing "Mark contacted" — the same transition, but on
            a lead who has already bought that label reads as a mistake in the
            interface rather than as an undo. */}
        {status === "converted" && (
          <StatusButton
            value="contacted"
            label={t("web.dashboard.leads.reopen")}
            aria={t("web.dashboard.leads.reopenAria", { name })}
            icon={Undo2}
            pending={pending}
          />
        )}
        {status !== "converted" && status !== "archived" && (
          <StatusButton
            value="converted"
            label={t("web.dashboard.leads.markConverted")}
            aria={t("web.dashboard.leads.markConvertedAria", { name })}
            icon={UserCheck}
            pending={pending}
          />
        )}
        {status !== "archived" ? (
          <StatusButton
            value="archived"
            label={t("web.dashboard.leads.archive")}
            aria={t("web.dashboard.leads.archiveAria", { name })}
            icon={Archive}
            pending={pending}
          />
        ) : (
          <StatusButton
            value="new"
            label={t("web.dashboard.leads.restore")}
            aria={t("web.dashboard.leads.restoreAria", { name })}
            icon={ArchiveRestore}
            pending={pending}
          />
        )}
        {state?.error && (
          <span role="alert" className="text-destructive basis-full text-xs">
            {state.error}
          </span>
        )}
      </form>
    </div>
  );
}

/**
 * One lifecycle transition.
 *
 * The visible label is the verb alone; the accessible name names the person,
 * because a screen-reader user tabbing a list of twenty leads otherwise hears
 * "Archive" twenty times with nothing to say which row it belongs to.
 */
function StatusButton({
  value,
  label,
  aria,
  icon: Icon,
  pending,
}: {
  value: LeadStatusValue;
  label: string;
  aria: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  pending: boolean;
}) {
  return (
    <Button
      type="submit"
      name="status"
      value={value}
      size="sm"
      variant="ghost"
      disabled={pending}
      aria-label={aria}
      className="text-muted-foreground hover:text-foreground"
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </Button>
  );
}
