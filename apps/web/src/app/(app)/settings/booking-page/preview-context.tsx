"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

// The two fields the preview can reflect WHILE they are being typed.
//
// Everything else on this screen (photo, video, languages, WhatsApp) is written
// by a Server Action that calls `revalidatePath("/settings/booking-page")`, so
// the server hands the preview its new value on the next render — no client
// mirror needed, and no chance of the two disagreeing. Headline and bio are the
// exception only because they are free text behind a Save button: without this,
// the teacher would have to save to find out whether her headline fits.
type Draft = { headline: string; bio: string };

type DraftContext = Draft & {
  setHeadline: (value: string) => void;
  setBio: (value: string) => void;
};

const BookingPageDraftContext = createContext<DraftContext | null>(null);

export function BookingPageDraftProvider({
  initialHeadline,
  initialBio,
  children,
}: {
  initialHeadline: string | null;
  initialBio: string | null;
  children: ReactNode;
}) {
  const [headline, setHeadline] = useState(initialHeadline ?? "");
  const [bio, setBio] = useState(initialBio ?? "");
  const value = useMemo(() => ({ headline, bio, setHeadline, setBio }), [headline, bio]);
  return (
    <BookingPageDraftContext.Provider value={value}>{children}</BookingPageDraftContext.Provider>
  );
}

/**
 * The live draft, for the preview and for the two forms that feed it.
 *
 * Returns null outside the provider on purpose rather than throwing: the
 * headline and bio forms are also rendered by tests and by the onboarding
 * preview step, neither of which has a preview to update.
 */
export function useBookingPageDraft(): DraftContext | null {
  return useContext(BookingPageDraftContext);
}
