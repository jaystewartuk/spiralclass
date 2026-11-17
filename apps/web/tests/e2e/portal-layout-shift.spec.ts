import { test, expect, type Page } from "@playwright/test";

import { applyE2ESkipGuards, getPrisma, missingEnv, signInAsViaOtp } from "./_helpers";

// The student portal must hold still while it loads (#90).
//
// Production's web vitals had the portal at p75 CLS 0.339 against 0.0 for the
// public booking page. The element was the site footer: every in-portal
// navigation shows the route's loading.tsx skeleton, which is shorter than the
// page, so the footer the root layout renders after the shell rose into view
// and dropped back when the content arrived. Measured on the class page at a
// 384px phone width: 0.32 on the way in, beside "Join video call".
//
// It only shows once the server takes longer than the 500ms a tap excuses, so
// this adds network latency and navigates through the router — no input event,
// so no shift is excused. CLS is summed over the whole visit, which is stricter
// than the web-vitals session window, and held to "good" (≤ 0.1).
//
// Signs in as Carlos, a shared read-only fixture of the deterministic seed core.

applyE2ESkipGuards({ extended: true });

const STUDENT_EMAIL = "carlos@alumno.test";
const GOOD_CLS = 0.1;
const LATENCY_MS = 400;

test.afterAll(async () => {
  if (missingEnv.length > 0 || process.env.E2E_EXTENDED !== "1") return;
  await getPrisma().$disconnect();
});

type Shift = { value: number; hadRecentInput: boolean; sources: string[] };

const OBSERVE_LAYOUT_SHIFTS = () => {
  const w = window as unknown as { __shifts: Shift[] };
  w.__shifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as unknown as Array<{
      value: number;
      hadRecentInput: boolean;
      sources?: Array<{ node?: Node | null }>;
    }>) {
      w.__shifts.push({
        value: entry.value,
        hadRecentInput: entry.hadRecentInput,
        sources: (entry.sources ?? []).map((s) =>
          s.node instanceof Element ? `${s.node.tagName.toLowerCase()}.${s.node.className}` : "",
        ),
      });
    }
  }).observe({ type: "layout-shift", buffered: true });
};

async function navigateWithoutInput(page: Page, path: string): Promise<void> {
  await page.evaluate(
    (href) =>
      (window as unknown as { next: { router: { push(h: string): void } } }).next.router.push(href),
    path,
  );
  await page.waitForURL((url) => url.pathname === path);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // Let the streamed page settle, and any late shift land.
  await page.waitForTimeout(2_000);
}

for (const viewport of [
  { name: "phone", width: 384, height: 800 },
  { name: "desktop", width: 1440, height: 900 },
]) {
  test(`the portal holds still while its pages load (${viewport.name})`, async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const booking = await getPrisma().booking.findFirstOrThrow({
      where: { student: { email: STUDENT_EMAIL } },
      orderBy: { scheduledStart: "desc" },
      select: { id: true },
    });

    await signInAsViaOtp(page, STUDENT_EMAIL, "/my-classes");
    await page.addInitScript(OBSERVE_LAYOUT_SHIFTS);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: LATENCY_MS,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    await page.goto("/my-classes", { waitUntil: "load" });
    await page.waitForTimeout(1_000);
    await navigateWithoutInput(page, `/my-classes/${booking.id}`);
    await navigateWithoutInput(page, "/my-classes/materials");
    await navigateWithoutInput(page, "/my-classes");

    const shifts = await page.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts);
    const counted = shifts.filter((s) => !s.hadRecentInput);
    const cls = counted.reduce((sum, s) => sum + s.value, 0);
    expect(
      cls,
      `layout shifts: ${JSON.stringify(counted.map((s) => [s.value.toFixed(3), ...s.sources]))}`,
    ).toBeLessThanOrEqual(GOOD_CLS);
  });
}
