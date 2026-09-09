import type { Metadata } from "next";
import Link from "next/link";
import { getT } from "@/lib/i18n";
import { BRAND } from "@/lib/email/html-shell";

// Email-only utility page whose URLs carry one-time codes — never indexable.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Browser fallback for the mobile magic link (`mobileLoginLink`). When the
// SpiralClass app is installed, Android's App Links hand a tapped
// spiralclass.com/m/login URL straight to the app (which signs the user in from
// the `email`+`code` params). This page only renders when that handoff DOESN'T
// happen — the link was opened on a desktop browser, or on a device without the
// app — so it explains how to finish: open the email on the phone, or type the
// one-time code (echoed here, since it's already in the user's own email) into
// the app. It never establishes a session itself; web sign-in lives at /sign-in.
export default async function MobileLoginFallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const code = typeof params.code === "string" ? params.code : null;
  const t = await getT();

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: BRAND.bg,
        color: BRAND.fg,
        padding: "2rem 1rem",
        fontFamily:
          "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "26rem",
          background: BRAND.cardBg,
          border: `1px solid ${BRAND.border}`,
          borderRadius: "14px",
          padding: "2rem 1.75rem",
          textAlign: "center",
        }}
      >
        <h1
          style={{
            margin: "0 0 0.75rem 0",
            fontFamily: "'Fraunces',Georgia,'Times New Roman',serif",
            fontSize: "1.5rem",
            fontWeight: 600,
            letterSpacing: "-0.015em",
          }}
        >
          {t("web.mobileLogin.heading")}
        </h1>
        <p style={{ margin: "0 0 1.5rem 0", lineHeight: 1.6, color: BRAND.mutedFg }}>
          {t("web.mobileLogin.intro")}
        </p>
        {code ? (
          <>
            <p style={{ margin: "0 0 0.5rem 0", fontSize: "0.9rem", color: BRAND.mutedFg }}>
              {t("web.mobileLogin.codeLabel")}
            </p>
            <p
              style={{
                margin: "0 0 1.5rem 0",
                fontSize: "2rem",
                fontWeight: 700,
                letterSpacing: "0.25em",
                color: BRAND.primary,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {code}
            </p>
          </>
        ) : null}
        <Link href="/sign-in" style={{ color: BRAND.primary, fontWeight: 500 }}>
          {t("web.mobileLogin.webLink")}
        </Link>
      </div>
    </main>
  );
}
