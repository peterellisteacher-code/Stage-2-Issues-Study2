# Deploy Notes -- read me before the first deploy runs

The repo ships with a GitHub Actions workflow at
`.github/workflows/deploy.yml` that deploys:

- **Backend** (Flask `server.py`) → Google Cloud Run on the existing GCP
  project `gen-lang-client-0274569601` in `us-central1`
- **Frontend** (HTML/CSS/JS + 137 PDFs in `readings/`) → Netlify
- **/api proxy** rewritten on Netlify to the Cloud Run URL

The workflow runs on every push to `main` and can also be triggered
manually from the **Actions** tab.

## Two secrets to add before the first run

Go to GitHub → repo Settings → Secrets and variables → Actions → **New
repository secret** and add:

| Name | Value | Where it comes from |
|---|---|---|
| `GCP_SA_KEY` | The full JSON contents of a service-account key with **Vertex AI User**, **Cloud Run Admin**, **Cloud Build Editor**, and **Service Account User** roles | Easiest: open `~/.mcp-servers/ai-image/service-account.json` and paste the file's contents (note: that key only has Vertex AI User by default; see the role-grant block below) |
| `NETLIFY_AUTH_TOKEN` | A personal access token from Netlify | https://app.netlify.com/user/applications#personal-access-tokens → "New access token" |

Optional once you've run the workflow once and a site exists:

| Name | Value |
|---|---|
| `NETLIFY_SITE_ID` | The site ID from `.netlify_site_id` (the workflow writes this back to the repo on first run, so this secret is only needed if you delete that file) |

## Granting the extra IAM roles to your service account

The default `vertex-express@gen-lang-client-0274569601.iam.gserviceaccount.com`
key has only **Vertex AI User**. Cloud Run + Cloud Build need three more.
From a machine with `gcloud` authenticated (or the GCP Console "IAM" UI):

```sh
PROJECT=gen-lang-client-0274569601
SA=vertex-express@gen-lang-client-0274569601.iam.gserviceaccount.com

for role in \
    roles/run.admin \
    roles/cloudbuild.builds.editor \
    roles/iam.serviceAccountUser \
    roles/storage.admin \
    roles/artifactregistry.writer ; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA" \
    --role="$role" --quiet
done
```

(The workflow already idempotently re-grants `roles/aiplatform.user` so
the existing role stays bound.)

## Triggering the first deploy

After both secrets are in:

1. Push any commit to `main` (or use the **Actions** tab → workflow →
   *Run workflow* → choose `main`).
2. The workflow will:
   - Build a Docker image from the `Dockerfile` and deploy to Cloud Run.
   - Create a new Netlify site with a random name (saved to
     `.netlify_site_id` for reuse).
   - Wire `BACKEND_URL` on Netlify and `CORS_ORIGINS` on Cloud Run.
   - Smoke-test the live URL.
   - Write `DEPLOY_REPORT.md` and push it back to the repo.
3. The Netlify URL appears in the workflow log and in `DEPLOY_REPORT.md`.

## Architecture (one diagram)

```
students  →  https://<name>.netlify.app
              ├── /                  static (Netlify CDN)
              ├── /readings/*.pdf   137 sources, cached for 1 year
              └── /api/*            redirect 200 → Cloud Run

Cloud Run (us-central1, autoscale 0-10)
  └── Vertex AI us-central1 (14 cluster caches, 70-day TTL, ~$0.39/day)
```

## Local development

The same `server.py` runs locally on `127.0.0.1:5050` with no env vars.
The Flask app reads:
- `PORT` (Cloud Run sets this to 8080) -- defaults to 5050 locally
- `HOST` -- defaults to 0.0.0.0 in containers, 127.0.0.1 locally
- `CORS_ORIGINS` -- comma-separated extra allowlist; loopback origins
  always included

## Cost expectation

| Item | Cost |
|---|---|
| Cloud Build (per deploy) | ~$0.05 |
| Cloud Run idle | $0 |
| Cloud Run per chat | ~$0.05 (cached input + output) |
| Cloud Run per feedback | ~$0.03 |
| Netlify | $0 (free tier covers a class) |
| Vertex caches storage | ~$0.39/day across 14 packs |
| GitHub | $0 (private repo, free Actions minutes) |

A 5-week cohort of 14 students at ~30 chats + 3 drafts/week each:
~$16 in Cloud Run + ~$30 in cache storage = **~$46 per cohort.** Inside
the existing $400 GCP promo pool.

## Things you should NOT change without thinking

- `Dockerfile` excludes `readings/` from the image -- they're served by
  Netlify's CDN, not the backend. If you put them back in the image, the
  Cloud Run image bloats from ~150 MB to ~400 MB and Netlify's
  `/readings/*` cache rule becomes pointless.
- `cache_handles.json` and `lab_corpus.json` reference Vertex AI
  cache_names. Those caches expire 70 days from the build (see
  BUILD_REPORT.md for the build date). When they expire, rebuild via
  `cache_unit_pack` from inside Claude Code and re-commit those JSON
  files.
- Service-account JSON must never enter the repo. The workflow uses
  `GCP_SA_KEY` from secrets; nothing else should reference a JSON path.
