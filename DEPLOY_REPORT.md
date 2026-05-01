# Deploy Report -- Issues Study Lab live

**Deployed:** 2026-04-27. Browser, backend, and reading PDFs all live.

## URLs

| Layer | URL |
|---|---|
| **Live site -- give this to students** | https://issues-study-lab.netlify.app |
| Backend (Cloud Run, us-central1) | https://issues-study-lab-167911956198.us-central1.run.app |
| Reading PDFs (public GCS bucket) | https://storage.googleapis.com/issues-study-lab-readings/ |
| Source repo | https://github.com/peterellisteacher-code/Stage-2-Issues-Study2 |
| Netlify dashboard | https://app.netlify.com/projects/issues-study-lab |

## Architecture

```
students  ->  https://issues-study-lab.netlify.app
              |
              +-- /                    static SPA (Netlify CDN)
              |
              +-- /readings/<file>     redirect 200 -> GCS bucket
              |                        (537 MB of PDFs, immutable cache)
              |
              +-- script.js calls cross-origin to Cloud Run for /api/*
                  (CORS allows the Netlify origin; needed because
                  Netlify edge proxy times out at 30 s and chat
                  calls take 60-90 s on a cold pack)

Cloud Run (us-central1, gunicorn 2 workers/4 threads)
  -- runs as vertex-express@gen-lang-client-0274569601.iam (Vertex AI User
     + Cloud Run Admin + Storage Admin)
  -- ADC via metadata server, no JSON on disk
  -- talks to Vertex AI us-central1 (14 cluster caches, 70-day TTL)
```

## Smoke test (2026-04-27 02:42 UTC)

- `GET https://issues-study-lab.netlify.app/api/questions` -> 102 questions, ~80 ms
- `GET https://issues-study-lab.netlify.app/readings/01b%20-%20Nozick%20-%20The%20Experience%20Machine.pdf` -> HTTP 200, served from GCS
- `POST /api/chat` (Q001 retributivism) -> 694 chars, $0.063, 78 s wall
- CORS preflight OK from `https://issues-study-lab.netlify.app` origin

## What's where

| Path | Hosted by |
|---|---|
| `/` (HTML / JS / CSS) | Netlify static |
| `/api/*` | Cloud Run (called cross-origin from JS to dodge Netlify's 30 s edge timeout) |
| `/readings/*` | GCS bucket via Netlify redirect |
| Vertex caches | Google's side; 14 cluster caches, 70-day TTL, ~$0.39/day storage |

## Costs (per the build)

- Cloud Build (one-off image build): ~$0.05
- Cloud Run idle: $0/day, scales to zero
- Cloud Run per chat: ~$0.05-0.07 (cached input at 10% of full Pro)
- Cloud Run per feedback: ~$0.02-0.05
- Vertex cache storage (14 packs, 70-day TTL): ~$0.39/day
- GCS storage (538 MB of PDFs): ~$0.01/month
- Netlify free tier: $0
- GitHub: $0

A 14-student cohort over 5 weeks with ~30 chats + 3 drafts/week each:
~$16 in Cloud Run + ~$30 cache storage = ~$46 per cohort. Well inside the
$400 GCP promo pool.

## What got built tonight

1. Pushed Issues_Study_Lab artefacts to the GitHub repo (102 questions,
   14 cluster caches, frontend, backend, build pipeline).
2. Created Netlify site `issues-study-lab` via the Netlify MCP.
3. Authenticated gcloud as Peter (Owner), enabled Cloud Resource Manager
   + Cloud Run + Cloud Build + Artifact Registry + IAM APIs.
4. Granted the Vertex SA the runtime + build roles
   (Vertex AI User, Cloud Run Admin, Service Account User,
   Artifact Registry Writer, Storage Admin).
5. Deployed the Flask broker to Cloud Run (revision 00002-c96).
6. Created public GCS bucket `gs://issues-study-lab-readings`,
   uploaded 137 reading PDFs, set CORS for browser access.
7. Wired Netlify redirects: `/readings/*` -> GCS, frontend -> Cloud Run.

## Sharp edges / known limits

- **First chat per cluster is slow** (60-90 s while Vertex warms the cache
  on the model side). Subsequent calls in the same cluster drop to 5-15 s.
  Acceptable for a study tool; consider streaming in a future session.
- **Netlify edge proxy 30 s timeout** is why chat calls go cross-origin
  to Cloud Run rather than via the proxy.
- **No streaming responses** -- the frontend blocks on the full reply.
  Adding SSE would mask the cold-start latency.
- **Service-account JSON never enters the repo.** The runtime SA is bound
  to the Cloud Run revision via `--service-account=`, picked up via ADC.
- **Default branch on GitHub is still `claude/deploy-to-netlify-bJVjT`**
  from the earlier Cross-Examination build. Switch to `main` in Settings
  -> Branches when convenient.

## Triggering a redeploy

- For the backend: from a local clone of the repo, run
  `gcloud run deploy issues-study-lab --source . --region us-central1
  --service-account=vertex-express@... --allow-unauthenticated --quiet`.
- For the frontend: call the Netlify MCP `deploy-site` operation, or run
  the Netlify CLI from the repo root.
- For new reading PDFs: upload to the GCS bucket
  (`gcloud storage cp newfile.pdf gs://issues-study-lab-readings/`).
