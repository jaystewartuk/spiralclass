"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Heading } from "@/components/ui/heading";
import { ToggleField } from "@/components/ui/toggle-field";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import type { StringKey } from "@/lib/i18n-translate";
import { CATEGORY_HINT_KEYS, CATEGORY_LABEL_KEYS } from "@/lib/notifications/category-labels";
import {
  NOTIFICATION_CATEGORIES,
  TEACHER_NOTIFICATION_CATEGORIES,
  isCategoryEnabled,
  type NotificationChannel,
  type TeacherNotificationChannel,
} from "@/lib/notifications/preferences";

/**
 * Notification preferences — the shared teacher/student form.
 *
 * ## The shape of the screen, and why it changed
 *
 * There are three layers between a notification being produced and it arriving,
 * and the form used to render them in an order that made none of them
 * comprehensible: the per-category channel chips came FIRST, the account-level
 * "global channel opt-ins" that override them came SECOND, and the browser
 * permission that makes push deliverable at all lived on a different card
 * entirely — which the push opt-in's own hint cheerfully described as "below".
 *
 * They now read in dependency order, top to bottom: HOW WE REACH YOU (the two
 * master switches, with the per-device browser control sitting directly under
 * push where it is the answer to why push is unavailable), then WHAT YOU GET
 * NOTIFIED ABOUT. Nothing below can be true if something above it is off, and
 * the form now SAYS so instead of leaving it to be discovered:
 *
 *  - Both channels off is a dead end — the recipient will receive nothing at
 *    all — and it is stated as a warning rather than left implied by two
 *    unchecked boxes.
 *  - For a teacher, email off is worse than it looks: payment, Stripe and
 *    billing notices are non-suppressible AND email-only, so turning email off
 *    silences the notices she cannot opt out of. That is a warning of its own.
 *  - A category whose channel is globally off says so inline rather than
 *    rendering a chip that claims to be on.
 *
 * ## Why the controls changed shape
 *
 * The channel chips were `px-2 py-0.5 text-xs` — roughly a 20px target against
 * D-140's 44px floor — and carried their state in a fill colour plus an
 * `aria-pressed` nobody sees. They are now 44px, and selection is a check mark
 * as well as a fill, because colour is never the only signal (D-140). The
 * category on/off went from a bare `Checkbox` to `ToggleField`, which is the
 * primitive that already solved the target size and the label-to-hint
 * `aria-describedby` wiring.
 *
 * ## Why every input is controlled now
 *
 * It used to mount `defaultChecked` checkboxes and read the answer back out of
 * FormData at submit time, which meant the form could not react to its own
 * state — no dirty tracking, no dependency between the master switches and the
 * chips they override, and a save button that was equally live whether or not
 * anything had changed. It also meant a comment explaining that React 19's
 * post-action form reset would visually undo a just-saved preference. A
 * controlled input is immune to that reset by construction, so the workaround
 * is gone with the thing it worked around.
 */

export type PrefsState = { ok?: boolean; error?: string } | undefined;

type Role = "student" | "teacher";

/** Student channels available for per-category selection. */
const STUDENT_CHANNELS: { id: NotificationChannel; labelKey: StringKey }[] = [
  { id: "email", labelKey: "web.notificationPrefs.channel.email" },
  { id: "push", labelKey: "web.notificationPrefs.channel.push" },
];

/** Teacher channels for per-category selection. */
const TEACHER_CHANNELS: { id: TeacherNotificationChannel; labelKey: StringKey }[] = [
  { id: "email", labelKey: "web.notificationPrefs.channel.email" },
  { id: "push", labelKey: "web.notificationPrefs.channel.push" },
];

// Groups the student category list under two headings instead of one flat
// stack of 5 checkboxes — matches defaultNewStudentNotificationPrefs()
// (lib/notifications/preferences.ts) so what's visually "essential" is also
// what's actually on by default. PostHog showed new students bouncing back
// to this screen repeatedly right after signup; a flat unlabeled list of 5
// toggles was the likely cause. Teacher categories stay a flat list — this
// is scoped to the student experience only.
const STUDENT_ESSENTIAL_CATEGORIES = new Set(["class_reminders", "booking_updates", "messages"]);

type ChannelProps = {
  emailOptIn: boolean;
  pushOptIn: boolean;
  hasPushDevice: boolean;
};

type Props = {
  role: Role;
  action: (state: PrefsState, formData: FormData) => Promise<PrefsState>;
  // Use an open index signature so that strongly-typed prefs objects (e.g.
  // TeacherNotificationPrefs with specific string-literal keys) are assignable
  // without the conflicting-boolean/channelPrefs intersection error.
  initialPrefs: { [key: string]: unknown; channelPrefs?: Partial<Record<string, string[]>> };
  /** Global "how to reach you" channel opt-ins. Null hides the whole group. */
  channels?: ChannelProps | null;
  /**
   * The per-browser push control (`<WebPushToggle />`). It belongs directly
   * under the push opt-in — it is the thing that makes push deliverable, and
   * the opt-in's hint points at it — but it is a Client Component with its own
   * lifecycle, so it arrives as a slot rather than as an import.
   */
  deviceSlot?: React.ReactNode;
};

/** The saved-and-editable state of the whole form, in one object. */
type FormValues = {
  enabled: Record<string, boolean>;
  channels: Record<string, string[]>;
  emailOptIn: boolean;
  pushOptIn: boolean;
};

/** Returns the initial channel selection for a category. Absent = all channels. */
function initialChannelList(
  channelPrefs: Partial<Record<string, string[]>> | undefined,
  category: string,
  allChannels: readonly string[],
): string[] {
  const stored = channelPrefs?.[category];
  if (!stored || stored.length === 0) return [...allChannels];
  const kept = stored.filter((c) => allChannels.includes(c));
  return kept.length > 0 ? kept : [...allChannels];
}

/** Order-insensitive identity for the dirty check. */
function fingerprint(values: FormValues, categories: readonly string[]): string {
  return JSON.stringify({
    e: categories.map((c) => values.enabled[c] === true),
    c: categories.map((c) => [...(values.channels[c] ?? [])].sort()),
    m: values.emailOptIn,
    p: values.pushOptIn,
  });
}

export function NotificationPrefsForm({
  role,
  action,
  initialPrefs,
  channels = null,
  deviceSlot = null,
}: Props) {
  const t = useT();
  const formId = useId();
  const [state, formAction, pending] = useActionState<PrefsState, FormData>(action, undefined);

  const categories = role === "student" ? NOTIFICATION_CATEGORIES : TEACHER_NOTIFICATION_CATEGORIES;
  const channelDefs = role === "student" ? STUDENT_CHANNELS : TEACHER_CHANNELS;
  const allChannelIds: readonly string[] = channelDefs.map((c) => c.id);

  // A LAZY INITIALIZER, not a `useMemo([])`: this is a mount-time snapshot, and
  // `useState` is the hook that expresses that without a lie about its
  // dependencies. It matters because the server re-renders this component with
  // fresh props after every save — deriving state from props on each render
  // would throw away whatever the reader had changed since.
  const [values, setValues] = useState<FormValues>(() => ({
    enabled: Object.fromEntries(categories.map((c) => [c, isCategoryEnabled(initialPrefs, c)])),
    channels: Object.fromEntries(
      categories.map((c) => [c, initialChannelList(initialPrefs.channelPrefs, c, allChannelIds)]),
    ),
    emailOptIn: channels?.emailOptIn ?? true,
    pushOptIn: channels?.pushOptIn ?? true,
  }));
  // What the server last accepted. The dirty check compares against THIS, not
  // against the mount-time snapshot, so the Save button goes quiet again once
  // a save lands instead of staying lit over changes already persisted.
  const [saved, setSaved] = useState<FormValues>(values);

  // The effect below fires on a settled action and needs whatever is on screen
  // at that moment — a ref rather than a dependency, because re-running it on
  // every keystroke would mark unsaved edits as saved.
  const latestValues = useRef(values);
  latestValues.current = values;

  useEffect(() => {
    if (state?.ok && !state.error) setSaved(latestValues.current);
  }, [state]);

  const dirty = fingerprint(values, categories) !== fingerprint(saved, categories);

  // Leaving with unsaved edits loses them silently. The browser supplies its
  // own wording (a custom string has been ignored for a decade), so this needs
  // no catalog entry.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function setCategoryEnabled(category: string, next: boolean) {
    setValues((prev) => ({ ...prev, enabled: { ...prev.enabled, [category]: next } }));
  }

  function toggleCategoryChannel(category: string, channel: string) {
    setValues((prev) => {
      const current = prev.channels[category] ?? allChannelIds;
      const next = current.includes(channel)
        ? // At least one channel always remains — a category with none would be
          // indistinguishable from one turned off, and the server drops an
          // empty list anyway.
          current.length <= 1
          ? current
          : current.filter((c) => c !== channel)
        : [...current, channel];
      return { ...prev, channels: { ...prev.channels, [category]: next } };
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData();
    for (const c of categories) if (values.enabled[c]) formData.set(c, "on");
    if (channels) {
      if (values.emailOptIn) formData.set("emailOptIn", "on");
      if (values.pushOptIn) formData.set("pushOptIn", "on");
    }
    // Per-category channel prefs travel as JSON in one hidden field, and only
    // when they RESTRICT — an entry listing every channel is the default and
    // would just be noise in the column.
    const cpJson: Record<string, string[]> = {};
    for (const c of categories) {
      const selected = values.channels[c] ?? allChannelIds;
      if (selected.length < allChannelIds.length) cpJson[c] = selected;
    }
    formData.set("channelPrefs", JSON.stringify(cpJson));
    startTransition(() => formAction(formData));
  }

  // Whether a channel can currently deliver anything at all. A per-category
  // chip stays editable when its channel is globally off — she is configuring
  // what happens when she turns it back on — but the section says plainly that
  // nothing goes out through it meanwhile.
  const emailLive = !channels || values.emailOptIn;
  const pushLive = !channels || (values.pushOptIn && channels.hasPushDevice);
  const unreachable = Boolean(channels) && !emailLive && !pushLive;

  const renderCategoryRow = (c: string) => {
    const enabled = values.enabled[c] ?? true;
    const selected = values.channels[c] ?? allChannelIds;
    const labelKey = CATEGORY_LABEL_KEYS[c];
    const hintKey = CATEGORY_HINT_KEYS[c];
    const categoryLabel = labelKey ? t(labelKey) : c;
    return (
      <div key={c} className="space-y-3 py-4 first:pt-0 last:pb-0">
        <ToggleField
          name={c}
          checked={enabled}
          onCheckedChange={(next) => setCategoryEnabled(c, next)}
          label={categoryLabel}
          hint={hintKey ? t(hintKey) : undefined}
        />
        {/* Named by the words already on screen rather than by an `aria-label`
            repeating them — one string, in one place, that cannot drift. */}
        <div
          role="group"
          aria-labelledby={`${formId}-${c}-deliver`}
          className="flex flex-wrap items-center gap-2"
        >
          <span
            id={`${formId}-${c}-deliver`}
            className={cn("text-muted-foreground text-sm", !enabled && "opacity-60")}
          >
            {t("web.notificationPrefs.deliverBy")}
          </span>
          {channelDefs.map((ch) => {
            const on = selected.includes(ch.id);
            // The sole remaining channel can't be removed; saying so with a
            // disabled control beats a click that silently does nothing.
            const isLastOn = on && selected.length <= 1;
            return (
              <button
                key={ch.id}
                type="button"
                disabled={!enabled || isLastOn}
                onClick={() => toggleCategoryChannel(c, ch.id)}
                aria-pressed={on}
                aria-label={t("web.notificationPrefs.channelToggle.label", {
                  channel: t(ch.labelKey),
                  category: categoryLabel,
                })}
                className={cn(
                  "focus-visible:ring-ring inline-flex h-11 items-center gap-1.5 rounded-full border-2 px-4 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:outline-hidden",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
                  // Dimmed only when the CATEGORY is off. A locked-on last
                  // channel keeps full contrast — fading it would read as
                  // "off", which is the opposite of what it means.
                  !enabled && "opacity-50",
                  enabled && isLastOn && "cursor-default",
                )}
              >
                {/* The non-colour half of the state signal. Hidden by opacity
                    rather than removed, so a chip does not resize as it
                    toggles and the row stops shifting under the pointer. */}
                <Check
                  className={cn("size-4 shrink-0", on ? "opacity-100" : "opacity-0")}
                  aria-hidden="true"
                />
                {t(ch.labelKey)}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const essentialCategories = categories.filter((c) => STUDENT_ESSENTIAL_CATEGORIES.has(c));
  const optionalCategories = categories.filter((c) => !STUDENT_ESSENTIAL_CATEGORIES.has(c));

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {channels && (
        <section aria-labelledby={`${formId}-reach`} className="space-y-4">
          <div className="space-y-1">
            <Heading level={4} as="h3" id={`${formId}-reach`}>
              {t("web.notificationPrefs.reach.title")}
            </Heading>
            <p className="text-muted-foreground text-sm">
              {t("web.notificationPrefs.reach.description")}
            </p>
          </div>

          {unreachable && (
            <Alert variant="warning" role="status">
              {t("web.notificationPrefs.unreachable")}
            </Alert>
          )}
          {/* Non-suppressible AND email-only is the combination that makes this
              worth a warning rather than a hint: turning email off silences
              exactly the notices she has no other way to receive. */}
          {role === "teacher" && !values.emailOptIn && !unreachable && (
            <Alert variant="warning" role="status">
              {t("web.notificationPrefs.emailOffCritical")}
            </Alert>
          )}

          <div className="divide-border space-y-0 divide-y">
            <div className="py-4 first:pt-0">
              <ToggleField
                name="emailOptIn"
                checked={values.emailOptIn}
                onCheckedChange={(next) => setValues((p) => ({ ...p, emailOptIn: next }))}
                label={t("web.notificationPrefs.channels.email")}
                hint={t("web.notificationPrefs.channels.emailHint")}
              />
            </div>
            <div className="space-y-4 py-4 last:pb-0">
              <ToggleField
                name="pushOptIn"
                checked={values.pushOptIn}
                onCheckedChange={(next) => setValues((p) => ({ ...p, pushOptIn: next }))}
                disabled={!channels.hasPushDevice}
                label={t("web.notificationPrefs.channels.push")}
                hint={
                  channels.hasPushDevice
                    ? t("web.notificationPrefs.channels.pushOnHint")
                    : t("web.notificationPrefs.channels.pushHint")
                }
              />
              {/* Directly under the switch it unblocks, rather than on another
                  card that the hint above described as "below". */}
              {deviceSlot ? <div className="border-border border-t pt-4">{deviceSlot}</div> : null}
            </div>
          </div>
        </section>
      )}

      <section aria-labelledby={`${formId}-what`} className="space-y-4">
        <div className="space-y-1">
          <Heading level={4} as="h3" id={`${formId}-what`}>
            {t("web.notificationPrefs.whichNotifications")}
          </Heading>
          <p className="text-muted-foreground text-sm">
            {t("web.notificationPrefs.categories.description")}
          </p>
        </div>

        {/* A chip that says "Email" while email is off account-wide is a lie of
            omission. Said once per section rather than once per row. */}
        {channels && !emailLive && (
          <p className="text-muted-foreground text-sm">{t("web.notificationPrefs.emailOffNote")}</p>
        )}
        {channels && !pushLive && (
          <p className="text-muted-foreground text-sm">{t("web.notificationPrefs.pushOffNote")}</p>
        )}

        {role === "student" ? (
          <div className="space-y-6">
            <div>
              <p className="text-muted-foreground mb-2 text-sm font-semibold">
                {t("web.notificationPrefs.group.essential")}
              </p>
              <div className="divide-border divide-y">
                {essentialCategories.map(renderCategoryRow)}
              </div>
            </div>
            {optionalCategories.length > 0 && (
              <div>
                <p className="text-muted-foreground mb-2 text-sm font-semibold">
                  {t("web.notificationPrefs.group.optional")}
                </p>
                <div className="divide-border divide-y">
                  {optionalCategories.map(renderCategoryRow)}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="divide-border divide-y">{categories.map(renderCategoryRow)}</div>
        )}

        <p className="text-muted-foreground text-sm">
          {role === "teacher"
            ? t("web.notificationPrefs.alwaysSent.teacher")
            : t("web.notificationPrefs.alwaysSent.student")}
        </p>
      </section>

      {/* A floating action bar rather than a button at the end of a form this
          long: the reader is usually mid-list when they finish deciding, and
          scrolling back down to find Save is not a step worth having.
          `bottom-4` rather than `bottom-0` so it does not depend on how much
          padding the calling row happens to use. Where an ancestor clips
          overflow (the student page's section card sets `overflow-hidden`,
          which turns off stickiness) it degrades to a static footer — the same
          bar, in the same place, just not pinned. */}
      <div className="border-border bg-card/95 shadow-brand-md supports-[backdrop-filter]:bg-card/85 sticky bottom-4 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3 backdrop-blur">
        <Button type="submit" disabled={pending || !dirty}>
          {pending ? t("web.notificationPrefs.saving") : t("web.notificationPrefs.savePreferences")}
        </Button>
        {dirty && !pending && (
          <Button type="button" variant="ghost" onClick={() => setValues(saved)}>
            {t("web.notificationPrefs.discard")}
          </Button>
        )}
        {/* Live region either way: "you have edits" is as worth announcing as
            "they saved". */}
        {dirty && !pending ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t("web.notificationPrefs.unsavedChanges")}
          </p>
        ) : (
          <FormStatus state={state} savedMessage={t("web.notificationPrefs.saved")} />
        )}
      </div>
    </form>
  );
}
