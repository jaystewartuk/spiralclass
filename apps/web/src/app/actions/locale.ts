"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  DEFAULT_LOCALE,
  isLocalePreference,
  matchAcceptLanguage,
  resolveLocale,
} from "@spiralclass/shared";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Persist the user's manual language *preference* via cookie so future requests
// bypass Accept-Language sniffing. The stored value is a LocalePreference: a
// concrete locale tag, or the "system" sentinel meaning "follow the browser"
// (the picker's System Default option). 1-year TTL; HttpOnly is fine since only
// the server reads this.
//
// When the user is logged in, mirror the *resolved* concrete locale onto their
// Teacher/Student row so server-side dispatch (email, push templates) honors the
// preference without request context — that column can't hold "system" (there's
// no request there to resolve it against), so we collapse it to a real locale at
// set time using this request's Accept-Language.
export async function setLocaleAction(formData: FormData): Promise<void> {
  const next = formData.get("locale");
  if (!isLocalePreference(next)) return;

  const store = await cookies();
  store.set(LOCALE_COOKIE, next, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: "lax",
  });

  const hdrs = await headers();
  const detected = matchAcceptLanguage(hdrs.get("accept-language")) ?? DEFAULT_LOCALE;
  const resolved = resolveLocale(next, detected);

  const user = await getAuthUser();
  if (user) {
    const teacher = await prisma.teacher.findUnique({
      where: { id: user.id },
      select: { id: true },
    });
    // `localeChosenAt` stamps this as a DELIBERATE pick, so nothing that
    // derives a locale from the environment may overwrite it. Picking
    // "System Default" counts: choosing to follow the browser is still a choice.
    const chosen = { locale: resolved, localeChosenAt: new Date() };
    if (teacher) {
      await prisma.teacher.update({ where: { id: teacher.id }, data: chosen });
    } else {
      await prisma.student.updateMany({ where: { authUserId: user.id }, data: chosen });
    }
  }

  revalidatePath("/", "layout");
}
