# Issues Study Lab

A web tool for SACE Stage 2 Philosophy students working on the
Issues Study (AT3 Investigation). The student picks a question, talks
to a Socratic interlocutor that pushes their thinking, drafts a
response, and asks for criterion-referenced feedback against the SACE
rubric and the closest SACE-supplied exemplar.

## Architecture

- **Static frontend** — `index.html`, `script.js`, `styles.css`. Wizard SPA.
- **Static data** — `data/questions.json`, `data/readings.json`, `data/rubric.json`. Loaded directly by the browser.
- **Two Netlify Functions** — `netlify/functions/chat.js` and `netlify/functions/feedback.js`. Both call the Anthropic API (Claude Haiku 4.5) with prompt caching.
- **Reading PDFs** — proxied from the Google Cloud Storage bucket via `/readings/*` (configured in `netlify.toml`).

```
browser ──► /data/*.json                           (static)
        └─► /api/chat        ──► Netlify Function ──► Anthropic (Haiku 4.5)
        └─► /api/feedback    ──► Netlify Function ──► Anthropic (Haiku 4.5)
        └─► /readings/*.pdf  ──► GCS bucket
```

## Pages

1. **Welcome** — student enters their name, sees what's coming.
2. **The task** — what SACE actually asks for, A vs C+ patterns, the seven criteria.
3. **The questions** — 102 questions across ethics / metaphysics / epistemology / political / religion / aesthetics. Filterable. Pick one.
4. **The readings** — curated primary + secondary sources for the chosen question, plus a dialectic blurb framing the debate.
5. **The chamber** — Socratic chat with Claude Haiku 4.5. A handoff fallback (copy prompt → open in Claude.ai / ChatGPT / Gemini) is available if the live chat fails.
6. **The drafting** — write space with autosave, criterion-referenced feedback against the SACE rubric and exemplar, and *Save as PDF* (browser print dialog).

## Deployment (Netlify)

1. Connect the GitHub repo to Netlify (Site settings → Build & deploy → Continuous deployment).
2. In **Site settings → Environment variables**, add:
   - `ANTHROPIC_API_KEY` — scoped to **Builds, Functions, Runtime**.
3. Push to `main`. Netlify auto-deploys: serves the static site and bundles the Functions.

No build step. `netlify.toml` declares `command = "echo 'no build step'"`.

## Local development

Install the Netlify CLI:

```sh
npm install -g netlify-cli
```

Then run:

```sh
netlify dev
```

This serves the static site, runs the Functions locally on the same port, and rewrites `/api/*` to them. The CLI reads `ANTHROPIC_API_KEY` from a local `.env` (git-ignored) — create one with:

```sh
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
```

## Costs

Per cohort of ~14 students, single SACE Issues Study cycle:

| Action | ~ Cost per call | Calls per cohort | Cohort total |
|---|---|---|---|
| Chamber chat turn (cached) | $0.0005 | ~420 | ~$0.21 |
| Chamber chat turn (cache miss / first turn) | $0.005 | ~14 | ~$0.07 |
| Feedback (full draft + rubric + exemplar) | $0.018 | ~70 | ~$1.26 |

Total: well under $5 per cohort. Pricing as of Sept 2025 (Haiku 4.5: $1/Mtok input, $5/Mtok output, $1.25/Mtok cache write, $0.10/Mtok cache read).

## Reading PDFs

The 137 reading PDFs sit in the GCS bucket `gs://issues-study-lab-readings`. The Netlify `/readings/*` redirect proxies to it. If students get 403s, re-enable `allUsers:objectViewer` on the bucket — or migrate the PDFs elsewhere (e.g. into the repo, Internet Archive, a Drive folder) and update the redirect target in `netlify.toml`.

## Files

| File | Role |
|---|---|
| `index.html`, `script.js`, `styles.css` | Frontend |
| `data/questions.json` | 102 question records |
| `data/readings.json` | Per-question dialectic + reading list |
| `data/rubric.json` | SACE task sheet, rubric, subject outline, three exemplars (A-/B/C+), domain → exemplar map |
| `netlify/functions/chat.js` | Chamber chat — Haiku 4.5 with prompt caching |
| `netlify/functions/feedback.js` | Single-shot feedback against rubric + exemplar |
| `netlify.toml` | Build, redirects, functions config, headers |
| `package.json` | Pins Node 20+. No runtime deps. |
| `build_static_data.py` | Script that regenerates `data/*.json` from the source pipeline |
| `extracted_docx/` | Raw exemplar + rubric source text (input to `build_static_data.py`) |
| `pack_metadata.json` | Source-of-truth for question → readings mapping (input to `build_static_data.py`) |

## Regenerating `data/*.json`

If you edit `pack_metadata.json` or files in `extracted_docx/`:

```sh
python build_static_data.py
```

Commit the regenerated JSONs and push.

## Why Haiku 4.5 (not Vertex)

The previous architecture used Vertex AI's context caching with 70-day cache handles against a clustered corpus of the readings. That broke when access to Vertex was lost. Claude Haiku 4.5 + Anthropic prompt caching fits the same use case without:

- 70-day cache handles to manage (Anthropic's caches are ephemeral, 5-min default, refresh on use).
- Custom corpus pre-clustering (the readings list is small enough to send per-request).
- Cloud Run / Flask broker (Netlify Functions handle the API call).

If a student loses access to the live chat (e.g. rate limit, key revoked), the *handoff fallback* on each chamber and feedback panel produces a copy-pasteable prompt for Claude.ai / ChatGPT / Gemini.
