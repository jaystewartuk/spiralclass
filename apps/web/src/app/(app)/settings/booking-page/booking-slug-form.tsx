"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyLinkButton } from "@/components/copy-link-button";
import { LogoSpinner } from "@/components/brand/logo-spinner";
import { useT } from "@/components/locale-provider";
import { saveBookingSlugAction, type SlugState } from "@/app/actions/profile";

type Availability =
  | { status: "current"; slug: string }
  | { status: "available"; slug: string }
  | { status: "taken"; slug: string; suggestions: string[] }
  | { status: "invalid"; reason: "too-short" | "reserved" };

type CheckState = "idle" | "checking" | Availability;

// Editor for the teacher's booking slug — the "enlace de reservas". Used both
// on the onboarding preview step and in Settings → Account. Shows the live
// public link with a copy button and an input pre-fixed with the host/b/
// prefix so the teacher only edits the slug itself. As they type we debounce a
// call to the availability endpoint and show "available / taken" inline, so a
// clash is caught before Save; the action still re-validates server-side and
// the DB unique constraint is the final gate.
export function BookingSlugForm({
  initialSlug,
  appUrl,
  showFullLink = true,
}: {
  initialSlug: string;
  appUrl: string;
  /**
   * Render the finished URL with a copy button above the editor.
   *
   * On the onboarding preview step this IS the point of the screen — "here is
   * your link, share it" — so it defaults on. Settings → Booking page turns it
   * off: its status card already shows, copies and opens the same URL, and two
   * copies of one string a screen apart made the editor read as a display.
   */
  showFullLink?: boolean;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<SlugState, FormData>(
    saveBookingSlugAction,
    undefined,
  );

  const [slug, setSlug] = useState(initialSlug);
  const [check, setCheck] = useState<CheckState>("idle");
  // The slug the editor is "settled" on — the persisted value. Typing back to
  // it (or to the original) is never flagged as taken.
  const savedSlugRef = useRef(initialSlug);

  // Adopt the canonical slug the server settled on (it may differ from what
  // was typed — e.g. accents stripped, spaces hyphenated).
  useEffect(() => {
    if (state?.slug) {
      setSlug(state.slug);
      savedSlugRef.current = state.slug;
      setCheck("idle");
    }
  }, [state?.slug]);

  // Debounced availability check. Skips the network call when the field is back
  // at the saved slug (that's trivially fine) or empty.
  useEffect(() => {
    const trimmed = slug.trim();
    if (trimmed === "" || trimmed === savedSlugRef.current) {
      setCheck("idle");
      return;
    }
    setCheck("checking");
    const controller = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/account/booking-slug?slug=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          setCheck("idle");
          return;
        }
        setCheck((await res.json()) as Availability);
      } catch {
        // Aborted (newer keystroke) or offline — drop silently; Save still
        // validates server-side.
      }
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(id);
    };
  }, [slug]);

  const base = appUrl.replace(/\/$/, "");
  const prefix = `${base.replace(/^https?:\/\//, "")}/b/`;
  const fullUrl = `${base}/b/${slug}`;

  const blocking =
    check !== "idle" &&
    check !== "checking" &&
    (check.status === "taken" || check.status === "invalid");

  // Inline guard for the one gap the live availability check leaves open: an
  // empty slug settles the check to "idle" (nothing to look up), so without
  // this a blank submit would only surface the error server-side. Reuse the
  // existing "invalid / too-short" state so the same inline hint + aria +
  // submit-disable already wired for a typed-but-invalid slug covers it too.
  // Typing again re-runs the debounced effect, which clears it back to idle.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    if (slug.trim() === "") {
      e.preventDefault();
      setCheck({ status: "invalid", reason: "too-short" });
    }
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="bookingSlug">
          {showFullLink ? t("bookingLink.title") : t("bookingLink.label")}
        </Label>
        {showFullLink && (
          <div className="bg-muted/40 flex items-center gap-2 rounded-md border px-3 py-2">
            <span className="flex-1 font-mono text-sm break-all">{fullUrl}</span>
            <CopyLinkButton value={fullUrl} iconOnly />
          </div>
        )}
        <div className="ring-offset-background focus-within:ring-ring flex items-stretch overflow-hidden rounded-md border focus-within:ring-3 focus-within:ring-offset-2">
          <span className="bg-muted text-muted-foreground flex items-center px-3 font-mono text-xs whitespace-nowrap select-none">
            {prefix}
          </span>
          <Input
            id="bookingSlug"
            name="bookingSlug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            maxLength={60}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="rounded-none border-0 font-mono focus-visible:ring-0"
            aria-invalid={blocking || state?.error ? true : undefined}
            aria-describedby={state?.error ? "bookingSlug-error" : "bookingSlug-availability"}
          />
        </div>
        <AvailabilityHint check={check} onPick={setSlug} />
        <p className="text-muted-foreground text-xs">{t("bookingLink.hint")}</p>
      </div>
      <FormStatus state={state} errorId="bookingSlug-error" savedMessage={t("bookingLink.saved")} />
      <Button type="submit" disabled={pending || blocking}>
        {pending ? t("web.settings.bookingPage.saving") : t("common.save")}
      </Button>
    </form>
  );
}

// Inline availability line under the slug input. Mirrors the four endpoint
// states plus the in-flight "checking" spinner; idle renders nothing. On a
// clash it also offers the free alternatives as one-tap chips.
function AvailabilityHint({
  check,
  onPick,
}: {
  check: CheckState;
  onPick: (slug: string) => void;
}) {
  const t = useT();

  if (check === "idle") return null;

  if (check === "checking") {
    return (
      <p
        id="bookingSlug-availability"
        className="text-muted-foreground flex items-center gap-1 text-xs"
      >
        <LogoSpinner size={14} />
        {t("bookingLink.checking")}
      </p>
    );
  }

  if (check.status === "current") {
    return (
      <p id="bookingSlug-availability" className="text-muted-foreground text-xs">
        {t("bookingLink.current")}
      </p>
    );
  }

  if (check.status === "available") {
    return (
      <p id="bookingSlug-availability" className="text-success flex items-center gap-1 text-xs">
        <Check className="h-3 w-3" aria-hidden />
        {t("web.settings.bookingPage.slugAvailable", { slug: check.slug })}
      </p>
    );
  }

  const message =
    check.status === "taken"
      ? t("bookingLink.error.slug-taken")
      : check.reason === "reserved"
        ? t("bookingLink.error.slug-reserved")
        : t("bookingLink.error.slug-too-short");

  const suggestions = check.status === "taken" ? check.suggestions : [];

  return (
    <div className="space-y-1.5">
      <p
        id="bookingSlug-availability"
        role="alert"
        aria-live="polite"
        className="text-destructive flex items-center gap-1 text-xs"
      >
        <X className="h-3 w-3" aria-hidden />
        {message}
      </p>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">{t("bookingLink.tryInstead")}</span>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="bg-background text-foreground hover:bg-accent hover:text-accent-foreground rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
