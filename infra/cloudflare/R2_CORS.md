# R2 bucket CORS

Several features upload **straight from the browser to Cloudflare R2** with a
presigned PUT — the bytes bypass the Next.js function entirely, because a video
or an audio file is far larger than a Server Action body can carry.

Because that PUT is **cross-origin** (`app origin → *.r2.cloudflarestorage.com`),
the browser only allows it if the bucket returns a matching **CORS** policy. Miss
it and the browser blocks the PUT before it leaves the tab, so the upload fails
with a generic error while the server sees nothing at all.

**A native client would not be affected** by a missing policy: it runs the identical
presign→PUT→finalize flow but is a native runtime not subject to CORS.

Playback needs no CORS. A `<video src>` / `<audio src>` is a plain media load,
not a `fetch`; only the upload PUT is a cross-origin request.

## What actually happened, 2026-08-30

The teacher's intro-video upload failed with _"We couldn't upload the video."_
The browser console had the real cause:

```
Access to fetch at 'https://<account>.r2.cloudflarestorage.com/agendaprofe-production-teacher-videos/...'
from origin 'https://spiralclass.com' has been blocked by CORS policy:
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

**Not a stale policy left behind by the rename.** The dashboard said
_"There is no CORS Policy defined for this bucket."_ — **none of the eight
buckets had ever had one.** Web upload to them had never worked.

What hid it: the intro video that WAS in the bucket had been uploaded from a
**native runtime**, which is not subject to CORS. The one client that could
upload was the one CORS cannot block, so the gap looked like a working feature
until someone tried it from a browser.

> [!WARNING]
> The first diagnosis of this was wrong in a way worth recording: the rename was
> assumed to have broken a policy listing `agendaprofe.com`, and that story was
> stated confidently before the dashboard was opened. The failure mode is
> identical either way — a thrown `fetch`, no HTTP status — so **only looking at
> the bucket distinguishes "wrong origins" from "no policy at all."** Look
> before concluding.

An earlier runbook (`r2-chat-media-cors.json`, commit `6888fd01`, 2026-07-08)
described this exact hazard for the chat-media bucket and **never merged** — it
survives only on `origin/claude/voice-video-messages-web-sxf5o8`. Its warning
was correct and unreadable. This file is its replacement, on `main`, widened to
every affected bucket.

## Which buckets need it

Only buckets that receive a **browser-side presigned PUT**:

| Bucket key          | Env prefix             | What uploads to it                                     |
| ------------------- | ---------------------- | ------------------------------------------------------ |
| `teacher-videos`    | `TEACHER_VIDEOS_R2`    | Teacher intro video (D-73), booking-page settings      |
| `chat-audio`        | `CHAT_AUDIO_R2`        | Chat voice notes, video, images and files (one bucket) |
| `class-materials`   | `CLASS_MATERIALS_R2`   | Homework file uploads                                  |
| `material-podcasts` | `MATERIAL_PODCASTS_R2` | Generated material podcasts                            |

**`teacher-photos` and `student-photos` do NOT need a policy.** Those upload
server-side through `getStorageProvider().upload` — the bytes go via the
function, so no cross-origin request is made. Adding one there is harmless but
meaningless; don't read its absence as a bug.

**Applied 2026-08-30** to all eight (production + preview) of the four above.
The bucket names still carry the old brand (`agendaprofe-production-*` /
`agendaprofe-preview-*`) — internal, deliberately not renamed. Read the real
name from the deploy's `<PREFIX>_BUCKET` secret rather than assuming.

## The origins

> [!IMPORTANT]
> **When a web origin changes, update this file and re-apply.** An origin list
> that exists only in a dashboard cannot be found by anyone searching the
> codebase, and will not survive a rename.

- `https://spiralclass.com` — production
- `https://preview.spiralclass.com` — preview (D-89)
- `http://localhost:3000` — local dev

`agendaprofe.com` is deliberately **absent**: the domain is no longer in the
Cloudflare account, so nothing can send that Origin.

`content-type` in the allowed headers is **load-bearing**: the upload sends it
on the PUT, and the preflight fails without it listed.

## Apply

Three files, one policy, three schemas — the tools genuinely disagree, and
picking the wrong one wastes a round trip:

| File                                                 | Shape                           | Used by                       |
| ---------------------------------------------------- | ------------------------------- | ----------------------------- |
| [`r2-cors.json`](./r2-cors.json)                     | `{ "CORSRules": [...] }`        | `aws s3api put-bucket-cors`   |
| [`r2-cors.wrangler.json`](./r2-cors.wrangler.json)   | `{ "rules": [{ "allowed" }] }`  | `wrangler r2 bucket cors set` |
| [`r2-cors.dashboard.json`](./r2-cors.dashboard.json) | bare `[ { "AllowedOrigins" } ]` | the dashboard's JSON box      |

### With wrangler

```sh
cd infra/cloudflare
npx wrangler login   # once; or set CLOUDFLARE_API_TOKEN

for B in teacher-videos chat-audio class-materials material-podcasts; do
  for ENV in production preview; do
    npx wrangler r2 bucket cors set "agendaprofe-$ENV-$B" --file r2-cors.wrangler.json
  done
done
```

### With the AWS CLI

Uses the bucket's own S3 credentials — no extra token needed:

```sh
cd infra/cloudflare

AWS_ACCESS_KEY_ID="$TEACHER_VIDEOS_R2_ACCESS_KEY" \
AWS_SECRET_ACCESS_KEY="$TEACHER_VIDEOS_R2_SECRET" \
AWS_DEFAULT_REGION=auto \
aws s3api put-bucket-cors \
  --endpoint-url "$TEACHER_VIDEOS_R2_ENDPOINT" \
  --bucket "$TEACHER_VIDEOS_R2_BUCKET" \
  --cors-configuration file://r2-cors.json
```

### From the dashboard

**R2 → the bucket → Settings → CORS Policy → Add**, and paste
`r2-cors.dashboard.json`.

⚠️ The JSON box is a CodeMirror editor with **auto-closing brackets**: typing a
complete document leaves trailing `"}]` and the policy is rejected as invalid.
Paste rather than type, or clear to end of document afterwards.

## Verify

The preflight, without needing a browser:

```sh
curl -i -X OPTIONS "$TEACHER_VIDEOS_R2_ENDPOINT/$TEACHER_VIDEOS_R2_BUCKET/probe" \
  -H "Origin: https://spiralclass.com" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type"
```

Expect `200` with `access-control-allow-origin` echoing the Origin and
`access-control-allow-methods` including `PUT`.

**A missing `access-control-allow-origin` is the fingerprint of this bug.** In
the browser it appears as a thrown `fetch` — not an HTTP error status — which
the intro-video uploader reports to PostHog as `intro_video_upload_failed` with
`reason: network`. A `reason: r2-put-<status>` is something else entirely: CORS
never gets far enough to return a status.
