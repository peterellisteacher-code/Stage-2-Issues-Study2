# Issues Study Lab -- Setup

How to run this on a fresh machine, or restore it after the 70-day cache
TTL has expired.

## Prerequisites

- Python 3.10+
- A GCP project with Vertex AI enabled and a service-account JSON with
  the **Vertex AI User** role
- Service-account JSON saved at `~/.mcp-servers/ai-image/service-account.json`
  (path is hard-coded in `server.py`; move/rename if you prefer another
  location)

## Install

```sh
cd Issues_Study_Lab
pip install -r requirements.txt
```

## Build the caches (one-time, or after TTL expiry)

The Lab depends on Vertex AI **context caches** -- one per thematic cluster.
The cluster definitions live in `lab_corpus.json` and the resolved
`cache_name` for each cluster is written to `unit_corpus_state.json` and
mirrored into `cache_handles.json`.

If you're starting from a fresh machine (no caches built yet):

1. Confirm `lab_corpus.json` and `pack_metadata.json` are present and
   point at PDFs that exist on disk. The default file paths assume the
   library is at `C:\Users\Peter Ellis\OneDrive\Teaching\Philosophy\Philosophy Texts\`
   plus `Issues_Study_Lab/text_packs/` for text-extracted versions of
   book-length sources.
2. From inside Claude Code (which is wired to the ai-image MCP server),
   build each cluster's cache:

   ```
   For each pack in lab_corpus.json:
   call cache_unit_pack(pack_name=<key>, corpus_path=<absolute path to lab_corpus.json>)
   ```

3. After all clusters are cached, regenerate `cache_handles.json` from
   `unit_corpus_state.json` so the runtime question_id -> cluster lookup
   resolves to live `cache_name`s. (See `scripts/`-style helpers if you
   add a regenerator.)

## Run the server

```sh
python server.py
```

Bound to `127.0.0.1:5050`. Open http://localhost:5050 in Chrome.

## What's where

| Purpose | File |
|---|---|
| Flask broker (4 endpoints) | `server.py` |
| Frontend UI | `index.html` + `script.js` + `styles.css` |
| Cluster definitions consumed by `cache_unit_pack` | `lab_corpus.json` |
| Question -> cluster -> cache_name registry | `cache_handles.json` |
| Per-question display metadata + readings | `pack_metadata.json` |
| Survivors after exclusion filter | `surviving_questions.json` |
| Filter exclusion report | `filter_report.json` |
| Cluster sizing + cost projection | `cluster_plan.json` |
| Filter + cluster pipeline | `filter_and_cluster.py` |
| Pre-process PDFs (text-extract big files) | `preprocess.py` |
| End-to-end test harness | `run_tests.py` |
| Reading PDFs students can download | `readings/` |
| Text-extracted versions for caching | `text_packs/` |
| SACE rubric + exemplars (plain text) | `extracted_docx/` |

## Costs (as of 2026-04)

- Build: ~1.6 M tokens at $1.25/M input on `gemini-2.5-pro` = ~$2 one-time
- Storage: ~$0.39/day across 14 clusters at the default 70-day TTL
- Per chat call: ~$0.001-0.01 (cached input at 10%, output at full Pro)
- Per feedback call: ~$0.02-0.05 (no cache; rubric + exemplar + draft)

The full $400 GCP promo pool comfortably absorbs a cohort.

## Security notes

- **Service-account JSON stays outside the repo.** Verified by `.gitignore`.
- Server binds to loopback only (`127.0.0.1`), not the LAN.
- CORS allows only `localhost:5050` and `127.0.0.1:5050`.
- The student-name field is for the export only; nothing is sent off-machine.

## Hosting on GitHub

This folder is GitHub-ready. The reading PDFs in `readings/` may push the
repo over GitHub's recommended 1 GB; if so, enable Git LFS for `*.pdf` or
host the readings on a separate static URL and update the link prefix in
`script.js`.
