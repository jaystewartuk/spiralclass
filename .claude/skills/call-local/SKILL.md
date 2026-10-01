---
name: call-local
description: See the in-class video call working locally — a teacher and a student in one room, both driven in Chrome — before opening a PR that touches the call screen, captions, in-call materials or notes, or anything under components/video. Use whenever a change to the call needs to be seen rendered, or to reproduce something a teacher or student reported from a class.
---

# /call-local

A call has two people in it, so seeing a call change means two signed-in
browsers in one LiveKit room. The hermetic E2E suite leaves the call out on
purpose; this is how it gets seen instead.

**Read the "The video call, by hand" section of
`docs/development/testing.md` first** — it is the source of truth, and its
table explains every setting the script makes. This skill is the order of
operations only.

1. `pnpm gate:lock` and `lsof -iTCP:3000` — another session's `pnpm dev` or
   E2E run owns the port; don't fight it.
2. Run `pnpm call:local` in the background (`--no-build` if nothing changed
   since the last build; `--student <email>` for another pair). Wait for
   `http://preview.localhost:3000/sign-in` to answer 200.
3. Teacher tab: `http://localhost:3000/sign-in` as
   `alicia.moreno@spiralclass.test`. Student tab:
   `http://preview.localhost:3000/sign-in` as the student. For each, click
   "Email me a code", run `pnpm call:local code <email>`, type `424242`.
   (Seeded test accounts on a local host — the test-credentials exception.)
4. Open the two call URLs the script printed. Each opens on the pre-join
   check with the camera preview ON. **Turn both cameras off before any
   screenshot** — both sides are the user's own webcam. Click the toggle
   through the DOM (`[data-testid="call-pre-join"]` → the button labelled
   "Camera off"), not by coordinates: the layout shifts when the device
   picker appears, and a coordinate click lands beside it.
   - If `document.visibilityState` is `hidden` (Chrome behind another
     window), the call mounts late and `requestAnimationFrame` never fires —
     the mic meter reads flat for that reason alone. A screenshot of a corner
     the preview does not cover brings the tab forward.
5. Put the data in the state the change is about with single-statement
   `psql` updates against `spiralclass-dev-db` (the doc says why single).
6. Check desktop, and phone width where the window allows it. Report what you
   saw, with screenshots, and say plainly what could not be exercised (speech).

When done: stop the server, `docker rm -f spiralclass-livekit-dev`, close the
tabs you opened.
