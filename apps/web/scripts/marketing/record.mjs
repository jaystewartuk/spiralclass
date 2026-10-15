// Records the landing-page clips from the running local app: real screens,
// driven the way a teacher and a student use them, with a cursor drawn in.
//
//   pnpm call:local                 # the stack: db, seed, LiveKit, production build on :3000
//   pnpm demo:fixtures              # the rows the clips show (scripts/marketing/demo-fixtures.ts)
//   pnpm demo:record [name ...]     # every clip, or the named ones
//
// Output: public/marketing/<name>.mp4 (H.264, muted) and <name>.jpg (poster),
// the files src/components/marketing/feature-clip.tsx plays. Each clip is
// re-recorded from scratch; the mp4 is what ships, so a clip is reproducible
// from this file rather than from a screen recording nobody can redo.
//
// Local only: it signs in with the seed's accounts on the two local hosts the
// call script sets up (teacher on localhost, student on preview.localhost).
import { chromium } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const T = "http://localhost:3000";
const S = "http://preview.localhost:3000";
const TEACHER = "alicia.moreno@spiralclass.test";
const STUDENT = "carlos@alumno.test";
const TEACHER_SLUG = "alicia-moreno-espanol";
const CODE = "424242";
const OUT = resolve(process.cwd(), "public/marketing");
const TMP = resolve(process.cwd(), "scripts/marketing/.tmp");
const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

function sql(q) {
  return execFileSync(
    "docker",
    ["exec", "-i", "spiralclass-dev-db", "psql", "-U", "postgres", "-d", "spiralclass", "-qAtc", q],
    { stdio: ["ignore", "pipe", "inherit"] },
  )
    .toString()
    .trim();
}

const ids = {
  teacher: sql(`select id from teachers where email='${TEACHER}'`),
  student: sql(`select id from students where email='${STUDENT}'`),
  // The class pnpm call:local moved to now.
  now: sql(
    `select b.id from bookings b join students s on s.id=b.student_id where s.email='${STUDENT}' and b.status='scheduled' and b.scheduled_start between now() - interval '1 hour' and now() + interval '1 hour' limit 1`,
  ),
  lastCompleted: sql(
    `select b.id from bookings b join students s on s.id=b.student_id where s.email='${STUDENT}' and b.status='completed' order by b.scheduled_start desc limit 1`,
  ),
  assignment: sql(
    `select a.id from assignments a join bookings b on b.id=a.booking_id join students s on s.id=b.student_id where s.email='${STUDENT}' order by a.created_at desc limit 1`,
  ),
};
for (const [k, v] of Object.entries(ids)) {
  if (!v) throw new Error(`no ${k} — run pnpm call:local and pnpm demo:fixtures first`);
}

// --- sign-in: the same trick scripts/local-call.sh uses — the code is stored
// hashed, so plant a known one over the real send.
function plantCode(email) {
  const hash = createHash("sha256").update(CODE).digest("base64url");
  sql(
    `update verification set value='${hash}:0', "expiresAt"=now()+interval '10 minutes' where identifier='sign-in-otp-${email}'`,
  );
}
async function signIn(page, origin, email, next) {
  await page.goto(`${origin}/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel(/email|correo/i).fill(email);
  await page.getByRole("button", { name: /email me a code|enviarme un código/i }).click();
  const code = page.getByLabel(/code|código/i);
  await code.waitFor({ timeout: 30_000 });
  for (let i = 0; i < 40; i += 1) {
    if (sql(`select 1 from verification where identifier='sign-in-otp-${email}'`)) break;
    await page.waitForTimeout(250);
  }
  plantCode(email);
  await code.fill(CODE);
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });
}

// --- a cursor the recording can see. Playwright's video has no pointer, so
// a dot follows page.mouse and pulses on click.
const CURSOR = `
(() => {
  if (window.top !== window) return;
  const dot = document.createElement("div");
  dot.id = "__rec_cursor";
  Object.assign(dot.style, {
    position: "fixed", left: "0", top: "0", width: "18px", height: "18px", borderRadius: "50%",
    background: "rgba(79, 70, 229, 0.85)", border: "2px solid white", boxShadow: "0 1px 6px rgba(0,0,0,.35)",
    pointerEvents: "none", zIndex: "2147483647", transform: "translate(-50%, -50%)", opacity: "0",
    transition: "opacity .2s, width .12s, height .12s",
  });
  const attach = () => document.documentElement.appendChild(dot);
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", attach) : attach();
  window.addEventListener("mousemove", (e) => {
    dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; dot.style.opacity = "1";
  }, true);
  window.addEventListener("mousedown", () => { dot.style.width = "28px"; dot.style.height = "28px"; }, true);
  window.addEventListener("mouseup", () => { dot.style.width = "18px"; dot.style.height = "18px"; }, true);
})();`;

const wait = (page, ms) => page.waitForTimeout(ms);

async function glide(page, x, y, steps = 24) {
  await page.mouse.move(x, y, { steps });
}
async function clickOn(page, locator, { hold = 500 } = {}) {
  await locator.first().scrollIntoViewIfNeeded();
  await wait(page, 250);
  const box = await locator.first().boundingBox();
  if (!box) throw new Error("no box for locator");
  await glide(page, box.x + box.width / 2, box.y + box.height / 2);
  await wait(page, hold);
  await page.mouse.down();
  await wait(page, 90);
  await page.mouse.up();
}
async function typeInto(page, locator, text, { delay = 45 } = {}) {
  await clickOn(page, locator, { hold: 300 });
  await page.keyboard.type(text, { delay });
}
async function scrollBy(page, px, ms = 1200) {
  await page.evaluate(
    ([d, t]) =>
      new Promise((done) => {
        const start = window.scrollY;
        const t0 = performance.now();
        const ease = (k) => (k < 0.5 ? 2 * k * k : -1 + (4 - 2 * k) * k);
        const tick = (now) => {
          const k = Math.min(1, (now - t0) / t);
          window.scrollTo(0, start + d * ease(k));
          k < 1 ? requestAnimationFrame(tick) : done();
        };
        requestAnimationFrame(tick);
      }),
    [px, ms],
  );
}
async function settle(page, ms = 900) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await wait(page, ms);
}

// --- one clip = one browser context with video on, one scripted scene.
async function clip(
  browser,
  name,
  { viewport = DESKTOP, phone = false, state, timezone, args, keep },
  scene,
) {
  const dir = join(TMP, `video-${name}`);
  rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: phone ? 2 : 1,
    isMobile: phone,
    hasTouch: phone,
    locale: "en-GB",
    timezoneId: timezone ?? "America/Mexico_City",
    storageState: state,
    recordVideo: { dir, size: viewport },
    ...(args ?? {}),
  });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  // Off-screen until the scene moves it, so the dot does not sit in a corner.
  await page.mouse.move(-20, -20);
  const extras = [];
  try {
    await scene(page, { ctx, browser, extras });
  } finally {
    for (const c of extras) await c.close().catch(() => {});
    await ctx.close();
  }
  const webm = readdirSync(dir)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).size - statSync(a).size)[0];
  if (!webm) throw new Error(`no video for ${name}`);
  const mp4 = join(OUT, `${name}.mp4`);
  const jpg = join(OUT, `${name}.jpg`);
  // Trim the first second (the blank frame before the first paint); `keep`
  // lists the [from, to] second ranges a long scene is cut down to. Even
  // dimensions for yuv420p.
  const ranges = keep ?? [[1, 10_000]];
  const filter =
    ranges.map(([a, b], i) => `[0:v]trim=${a}:${b},setpts=PTS-STARTPTS[s${i}]`).join(";") +
    ";" +
    ranges.map((_, i) => `[s${i}]`).join("") +
    `concat=n=${ranges.length}:v=1:a=0,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24[v]`;
  run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    webm,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "27",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    mp4,
  ]);
  run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    "1.5",
    "-i",
    mp4,
    "-frames:v",
    "1",
    "-q:v",
    "4",
    jpg,
  ]);
  console.log(`  ${name}: ${(statSync(mp4).size / 1024).toFixed(0)} KB`);
  rmSync(dir, { recursive: true, force: true });
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} failed`);
}

const SCENES = {
  // A student books and pays from the link she shared, on her phone.
  async booking(browser) {
    await clip(browser, "booking", { viewport: PHONE, phone: true }, async (page) => {
      await page.goto(`${S}/b/${TEACHER_SLUG}`);
      await settle(page, 1200);
      await glide(page, 200, 500, 10);
      await scrollBy(page, 520, 1600);
      await wait(page, 900);
      await scrollBy(page, 700, 1800);
      await wait(page, 900);
      await scrollBy(page, -1220, 1400);
      await wait(page, 600);
      await clickOn(page, page.locator(`a[href*="/b/${TEACHER_SLUG}/buy"]`));
      await settle(page, 1200);
      await typeInto(page, page.getByLabel(/your name/i), "Carlos Ruiz");
      await typeInto(page, page.getByLabel(/your email/i), "carlos@alumno.test", { delay: 30 });
      await wait(page, 400);
      await scrollBy(page, 560, 1400);
      await wait(page, 500);
      const slot = page.locator("fieldset button").first();
      if (await slot.count()) await clickOn(page, slot);
      await wait(page, 800);
      await scrollBy(page, -560, 1200);
      const pay = page.getByRole("button", { name: /^pay/i });
      await pay.scrollIntoViewIfNeeded();
      const box = await pay.boundingBox();
      if (box) await glide(page, box.x + box.width / 2, box.y + box.height / 2);
      await wait(page, 1800);
    });
  },

  // Her morning: the dashboard, the calendar, the day's plan.
  async dashboard(browser, { teacher }) {
    await clip(
      browser,
      "dashboard",
      { state: teacher, timezone: "America/Costa_Rica" },
      async (page) => {
        await page.goto(`${T}/dashboard`);
        await settle(page, 1400);
        await glide(page, 640, 300, 10);
        await scrollBy(page, 420, 1500);
        await wait(page, 1200);
        await scrollBy(page, -420, 1000);
        await clickOn(page, page.getByRole("link", { name: /^calendar$/i }));
        await settle(page, 1200);
        await clickOn(page, page.getByRole("link", { name: /^week$/i }));
        await wait(page, 1600);
        await clickOn(page, page.getByRole("link", { name: /^classes$/i }));
        await settle(page, 1400);
        await scrollBy(page, 300, 1200);
        await wait(page, 1200);
      },
    );
  },

  // The class itself, seen from the student's side: the teacher opens a
  // material for both of them and turns captions on; what she says appears
  // in the student's language. With DEMO_MIC_WAV her microphone is a voice
  // file (on-device English recognition is what headless Chrome can do), so
  // the recording needs the class set to English and the student to Spanish:
  //   update bookings set teacher_language_override='en' where id=<now>;
  //   update students set native_language='es' where email=<student>;
  async call(browser, { teacher, student }) {
    await clip(
      browser,
      "call",
      // Joining and the material, then the captions once the voice file has
      // been heard; the wait in between is cut.
      {
        state: student,
        timezone: "America/Toronto",
        keep: [
          [4.5, 15],
          [30, 54],
        ],
      },
      async (page, { browser: b, extras }) => {
        const tctx = await b.newContext({
          viewport: DESKTOP,
          locale: "en-GB",
          timezoneId: "America/Costa_Rica",
          storageState: teacher,
        });
        extras.push(tctx);
        const tp = await tctx.newPage();
        await tp.goto(`${T}/dashboard/classes/${ids.now}/call`);
        await tp.getByTestId("call-pre-join").waitFor({ timeout: 30_000 });
        const tCamOff = tp
          .getByTestId("call-pre-join")
          .getByRole("button", { name: /^camera off$/i });
        if (await tCamOff.count()) await tCamOff.click();
        await tp.getByTestId("call-pre-join-join").click();

        await page.goto(`${S}/my-classes/${ids.now}/call`);
        await page.getByTestId("call-pre-join").waitFor({ timeout: 30_000 });
        await wait(page, 1500);
        // Both cameras off: the fake camera Chrome offers is a test pattern.
        const camOff = page
          .getByTestId("call-pre-join")
          .getByRole("button", { name: /^(camera off|apagar cámara)$/i });
        if (await camOff.count()) await clickOn(page, camOff);
        await wait(page, 600);
        await clickOn(page, page.getByTestId("call-pre-join-join"));
        // Only the teacher speaks in this clip; the student's fake microphone
        // would otherwise play the same voice file.
        const mute = page.getByRole("button", { name: /^(mute|silenciar)$/i });
        await mute.waitFor({ timeout: 20_000 });
        await clickOn(page, mute);
        await wait(page, 2500);

        await tp.getByTestId("call-materials-button").click();
        await wait(page, 900);
        await tp
          .getByTestId("call-materials-sheet")
          .getByRole("button")
          .filter({ hasText: /mercado|imperfecto/i })
          .first()
          .click();
        await wait(page, 700);
        const both = tp.getByTestId("call-material-open-both");
        if (await both.count()) await both.click();
        await wait(page, 3500);
        await glide(page, 640, 300, 12);
        await scrollBy(page, 260, 1400).catch(() => {});
        await wait(page, 1800);
        const close = page.getByTestId("call-material-viewer-close");
        if (await close.count()) await clickOn(page, close);
        await tp
          .getByTestId("call-material-viewer-close")
          .click()
          .catch(() => {});
        await tp.keyboard.press("Escape");
        await wait(page, 800);

        const captions = tp.getByRole("button", { name: /^captions$/i });
        if (await captions.count()) {
          await captions.click();
          await wait(page, 800);
          const gotIt = tp.getByRole("button", { name: /got it/i });
          if (await gotIt.count()) await gotIt.click();
          const accept = page.getByRole("button", { name: /^(turn on|activar)$/i });
          await accept.waitFor({ timeout: 10_000 }).catch(() => {});
          if (await accept.count()) await clickOn(page, accept);
          await wait(page, process.env.DEMO_MIC_WAV ? 28_000 : 5000);
        }
        await wait(page, 1500);
      },
    );
  },

  // Materials: her library by level, the class plan, what the student reads.
  async materials(browser, { teacher }) {
    await clip(
      browser,
      "materials",
      { state: teacher, timezone: "America/Costa_Rica" },
      async (page) => {
        await page.goto(`${T}/dashboard/materials`);
        await settle(page, 1200);
        await clickOn(page, page.getByRole("link", { name: /\bB1\b/ }));
        await settle(page, 1200);
        await scrollBy(page, 200, 900);
        await wait(page, 1000);
        await page.goto(`${T}/dashboard/classes/${ids.now}/content`);
        await settle(page, 1200);
        await glide(page, 640, 360, 10);
        await scrollBy(page, 520, 1800);
        await wait(page, 1400);
        await scrollBy(page, 420, 1400);
        await wait(page, 1400);
      },
    );
  },

  // After class: the findings she confirms, the profile they build, the brief
  // before the next class, and the student's own vocabulary review.
  async learning(browser, { teacher, student }) {
    await clip(
      browser,
      "learning",
      { state: teacher, timezone: "America/Costa_Rica" },
      async (page) => {
        await page.goto(`${T}/dashboard/classes/${ids.lastCompleted}`);
        await settle(page, 1200);
        const findings = page.getByText(/preterite where the background/i).first();
        if (await findings.count()) {
          await findings.scrollIntoViewIfNeeded();
          await scrollBy(page, -120, 600);
          await wait(page, 1200);
          const confirm = page.getByRole("button", { name: /^confirm$/i }).first();
          if (await confirm.count()) await clickOn(page, confirm);
          await wait(page, 1600);
        }
        await page.goto(`${T}/dashboard/students/${ids.student}?tab=learning`);
        await settle(page, 1200);
        await glide(page, 900, 300, 10);
        await scrollBy(page, 220, 1200);
        await wait(page, 1600);
        await page.goto(`${T}/dashboard/classes/${ids.now}`);
        await settle(page, 1000);
        const brief = page.getByText(/longer stretches/i).first();
        if (await brief.count()) {
          await brief.scrollIntoViewIfNeeded();
          await scrollBy(page, -160, 600);
        }
        await wait(page, 2200);
      },
    );
    await clip(
      browser,
      "vocabulary",
      { viewport: PHONE, phone: true, state: student, timezone: "America/Toronto" },
      async (page) => {
        await page.goto(`${S}/my-classes/progress`);
        await settle(page, 1400);
        await glide(page, 195, 400, 10);
        await scrollBy(page, 260, 1000);
        await wait(page, 800);
        const card = page.getByText(/tap to flip/i).first();
        if (await card.count()) await clickOn(page, card);
        await wait(page, 1400);
        const good = page.getByRole("button", { name: /^good$/i });
        if (await good.count()) await clickOn(page, good);
        await wait(page, 1200);
        const card2 = page.getByText(/tap to flip/i).first();
        if (await card2.count()) await clickOn(page, card2);
        await wait(page, 1200);
        const easy = page.getByRole("button", { name: /^easy$/i });
        if (await easy.count()) await clickOn(page, easy);
        await wait(page, 1500);
      },
    );
  },

  // Homework: what the student handed in, her feedback, the decision.
  async homework(browser, { teacher }) {
    await clip(
      browser,
      "homework",
      { state: teacher, timezone: "America/Costa_Rica" },
      async (page) => {
        await page.goto(`${T}/dashboard/classes/${ids.lastCompleted}/homework/${ids.assignment}`);
        await settle(page, 1400);
        await glide(page, 640, 320, 10);
        await scrollBy(page, 260, 1200);
        await wait(page, 1200);
        await typeInto(
          page,
          page.getByLabel(/^feedback/i),
          'Muy bien, Carlos. El imperfecto está perfecto en siete de ocho frases. Mira la última: "fui muy feliz" describe una época, así que... ¿cuál sería?',
          { delay: 22 },
        );
        await wait(page, 500);
        await typeInto(page, page.getByLabel(/score/i), "9");
        await wait(page, 600);
        await clickOn(page, page.getByRole("button", { name: /^approve$/i }));
        await settle(page, 2000);
      },
    );
  },

  // Messages: a question from the student, answered in the same place.
  async messages(browser, { teacher, student }) {
    await clip(
      browser,
      "messages",
      { state: teacher, timezone: "America/Costa_Rica" },
      async (page, { browser: b, extras }) => {
        await page.goto(`${T}/dashboard/messages/${ids.student}`);
        await settle(page, 1200);
        const sctx = await b.newContext({
          viewport: DESKTOP,
          locale: "en-GB",
          timezoneId: "America/Toronto",
          storageState: student,
        });
        extras.push(sctx);
        const sp = await sctx.newPage();
        await sp.goto(`${S}/my-classes/messages/${ids.teacher}`);
        await sp.waitForLoadState("networkidle").catch(() => {});
        const box = sp.getByPlaceholder(/write a message/i);
        await box.fill("¿Puedo mover la clase del sábado a las 6?");
        await box.press("Enter");
        await wait(page, 4500);
        await typeInto(
          page,
          page.getByPlaceholder(/write a message/i),
          "Claro, a las 6 está perfecto. Te lo muevo ahora 👍",
          { delay: 35 },
        );
        await wait(page, 300);
        await page.keyboard.press("Enter");
        await wait(page, 2500);
      },
    );
  },

  // Money: what she earned this month, what students paid in advance.
  async payments(browser, { teacher }) {
    await clip(
      browser,
      "payments",
      { state: teacher, timezone: "America/Costa_Rica" },
      async (page) => {
        await page.goto(`${T}/payments`);
        await settle(page, 1600);
        await glide(page, 640, 300, 10);
        await scrollBy(page, 300, 1400);
        await wait(page, 900);
        const sept = page.getByRole("button", { name: /september/i }).first();
        if (await sept.count()) await clickOn(page, sept);
        await wait(page, 1800);
        await scrollBy(page, 320, 1200);
        await wait(page, 1400);
      },
    );
  },

  // Getting students: the week's plan, and what actually worked.
  async students(browser, { teacher }) {
    await clip(
      browser,
      "students",
      { state: teacher, timezone: "America/Costa_Rica" },
      async (page) => {
        await page.goto(`${T}/dashboard/get-students`);
        await settle(page, 1400);
        await glide(page, 500, 320, 10);
        await wait(page, 1200);
        await scrollBy(page, 240, 1200);
        await wait(page, 1000);
        await clickOn(page, page.getByRole("link", { name: /^results$/i }));
        await settle(page, 1200);
        await scrollBy(page, 200, 1000);
        await wait(page, 1400);
      },
    );
  },
};

async function main() {
  const only = process.argv.slice(2);
  const names = only.length ? only : Object.keys(SCENES);
  for (const n of names)
    if (!SCENES[n]) throw new Error(`unknown clip ${n}; have ${Object.keys(SCENES).join(", ")}`);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      ...(process.env.DEMO_MIC_WAV
        ? [`--use-file-for-fake-audio-capture=${process.env.DEMO_MIC_WAV}`]
        : []),
    ],
  });
  console.log("signing in…");
  const teacher = join(TMP, "teacher.json");
  const student = join(TMP, "student.json");
  {
    const c = await browser.newContext({ viewport: DESKTOP, locale: "en-GB" });
    await signIn(await c.newPage(), T, TEACHER, "/dashboard");
    await c.storageState({ path: teacher });
    await c.close();
    const s = await browser.newContext({ viewport: DESKTOP, locale: "en-GB" });
    await signIn(await s.newPage(), S, STUDENT, "/my-classes");
    await s.storageState({ path: student });
    await s.close();
  }
  for (const n of names) {
    console.log(`recording ${n}…`);
    await SCENES[n](browser, { teacher, student });
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
