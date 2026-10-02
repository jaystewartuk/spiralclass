// @vitest-environment jsdom
//
// Embedded Stripe onboarding speaks the language the teacher reads the app in.
// Connect.js was never told one, so it followed her browser: a teacher using
// the app in Spanish on an English-language laptop got her identity
// verification in English.
//
// The second half matters as much as the first. The effect that initializes
// Connect.js reaches a server action that CREATES A LIVE STRIPE ACCOUNT, and an
// account the platform creates can never be deleted (D-143). Its ref guard is
// what keeps that to exactly once per mount, and the language is now something
// the effect reads — so a language change must not be able to run it again.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import type { AppLocale } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const loadConnectAndInitialize = vi.fn((_options: { locale?: string }) => ({}));
vi.mock("@stripe/connect-js", () => ({ loadConnectAndInitialize }));
vi.mock("@stripe/react-connect-js", () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => children,
  ConnectAccountOnboarding: () => null,
}));
vi.mock("@/app/actions/stripe-connect", () => ({
  startEmbeddedConnectOnboarding: vi.fn(async () => ({ clientSecret: "accs_secret" })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

const { StripeConnectEmbeddedOnboarding } =
  await import("@/app/(app)/settings/payments/stripe-connect-embedded");
const { LocaleProvider } = await import("@/components/locale-provider");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  loadConnectAndInitialize.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const mount = (locale: AppLocale) =>
  act(() =>
    root.render(
      <LocaleProvider locale={locale}>
        <StripeConnectEmbeddedOnboarding publishableKey="pk_test_x" />
      </LocaleProvider>,
    ),
  );

describe("embedded Stripe onboarding — language", () => {
  it.each([
    ["es", "es-419"],
    ["en", "en-US"],
    ["fr", "fr-FR"],
  ] as const)("initializes Connect.js in %s as %s", async (locale, connectLocale) => {
    await mount(locale);

    expect(loadConnectAndInitialize).toHaveBeenCalledTimes(1);
    expect(loadConnectAndInitialize.mock.calls[0][0].locale).toBe(connectLocale);
  });

  it("does not initialize a second time when her language changes", async () => {
    await mount("es");
    await mount("fr");
    await mount("en");

    expect(loadConnectAndInitialize).toHaveBeenCalledTimes(1);
  });
});
