# Docs site (docs.spiralclass.com)

> [!NOTE]
> **2026-08-29 (D-139): `infra/cloudflare` is deleted.** It was never applied
> and had no state, and a first `apply` would have created a _second_ Access
> application on the same hostname rather than adopting the hand-made one.
> This document is now the only description of that gate.

The `docs/` tree is published as a searchable, password-protected site built
with **[MkDocs Material](https://squidfunk.github.io/mkdocs-material/)**. It
renders the repo's markdown directly — every push to `main` redeploys the site,
so the published docs are always current with the branch.

- **Source:** `mkdocs.yml` (repo root) + `docs/**/*.md`. The folder tree _is_ the
  nav (via the `awesome-nav` plugin); `docs/README.md` is the homepage.
- **Search:** Material's built-in offline client-side index — no external service.
- **Host:** Cloudflare Workers static assets (`wrangler.jsonc` → `./site`),
  built on Cloudflare's own quota, not GitHub minutes.
- **Auth:** Cloudflare Access (Zero Trust) — an allowlist policy on the hostname.
- **Deps:** `requirements.txt` (Python). This is the _only_ Python in the repo
  and is independent of the pnpm build.

## Preview locally

```sh
python3 -m venv .venv-docs          # .venv-docs is gitignored
.venv-docs/bin/pip install -r requirements.txt
.venv-docs/bin/mkdocs serve         # live-reload at http://127.0.0.1:8000
```

Build the static site (what Cloudflare runs): `mkdocs build` → `site/`.

## Cloudflare Workers setup (one-time)

The newer unified dashboard only exposes **Workers & Pages → Create
application**; there's no separate Pages Git flow. The site deploys as a
**static-assets-only Worker** driven by `wrangler.jsonc` (repo root), which
points the Worker at the `./site` build output — that config file is the one
thing this path needs that Pages gave for free.

1. **Workers & Pages → Create application → Connect to Git** → this repo,
   production branch `main`. Name the application `agendaprofe-docs` (must match
   `name` in `wrangler.jsonc`).
2. Build & deploy settings:
   - Build command: `pip install -r requirements.txt && mkdocs build`
   - Deploy command: `npx wrangler deploy` (reads `wrangler.jsonc`)
   - Environment variable: `PYTHON_VERSION = 3.12`
   - Let it **create the API token** — that's just its Git-integration credential.
3. **Custom domain:** the Worker → **Settings → Domains & Routes → Add custom
   domain** → `docs.spiralclass.com` (the zone must be on Cloudflare DNS).

## Cloudflare Access setup (the password gate)

> ⚠️ **Done by hand, not by Terraform.** `infra/cloudflare/` has never been
> applied and has no state; the live application was created in the dashboard
> and edited there. It gates **both** `docs.spiralclass.com` and
> `docs.agendaprofe.com` (one application, `self_hosted_domains`), owner-only,
> 168h session. The block below describes what the module _would_ do, not what
> was done.

**There is no Terraform for this any more.** `infra/cloudflare/` was deleted
on 2026-08-29 ([D-139](../decisions/D-139.md)) precisely because applying it
would have created a _second_ Access application on the same hostname instead
of adopting the hand-made one, and its single `domain` variable could not
express the `self_hosted_domains` list that protects both hostnames.

**To recreate the gate:** Cloudflare Zero Trust → Access → Applications → Add
→ Self-hosted. One application covering **both** `docs.spiralclass.com` and
`docs.agendaprofe.com`, an allow policy scoped to the owner email with
one-time-PIN login, 168h session. **Create the gate before exposing the
hostname**, so the docs are never briefly public.

Prereq: the Worker's custom domain must be live (traffic routes through
Cloudflare) before the gate can be enforced. Free Zero Trust covers ≤50 users.
The equivalent manual path is Zero Trust → Access → Applications → Add →
Self-hosted, if you'd rather click it.

## Known link warnings

`mkdocs build` warns on links that point _outside_ `docs/` — the repo-root
`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `config/env/README.md` and the
source paths the architecture documents cite. These cannot resolve in a
docs-only site and are left as-is on purpose; they are correct on GitHub, which
is where most readers meet them. Fix an individual one by pointing at the GitHub
blob URL if a live link is wanted. The build stays non-strict so these never
fail it.

⚠️ These are warnings, not permission to leave a link broken.
`apps/web/tests/config/doc-links.test.ts` fails the gate on any relative link
that resolves to nothing, and it has no exception list.
