# Issues Study Lab — Architecture

**Status:** Post-Vertex rebuild, May 2026
**Scope:** 102 questions, 14 cluster packs, classroom multi-user

## What changed and why

The original architecture (April 2026) used a Flask broker on Cloud Run
calling Vertex AI's `gemini-2.5-pro` with `cached_content=` for the
Chamber, plus a service-account-scoped GCS bucket for the readings PDFs.
That whole stack was retired when Vertex access ended.

The replacement keeps the same student experience (5-step wizard,
in-app Chamber chat, rubric-referenced feedback, per-question
autosave) but moves every server-side dependency:

| | Before | Now |
|---|---|---|
| AI provider | Vertex AI (`gemini-2.5-pro`) | Anthropic API (`claude-haiku-4-5`) |
| Chamber backend | Cloud Run + Flask | Netlify Functions (Node.js) |
| Caching strategy | Vertex `cached_content`, 70-day TTL, manually built | Anthropic prompt caching, 5-min ephemeral, auto-renews on hit |
| Auth surface | GCP service-account JSON | Anthropic API key in Netlify env var |
| Readings hosting | GCS bucket via Netlify reverse-proxy | Static commit, Netlify CDN |
| PDF export | Server-rendered with PyMuPDF | `window.print()` against an injected print-only view |
| Deploy | GitHub Actions → Cloud Run + Netlify | Netlify auto-deploy on push |

## Components

```
┌──────────────────────────────────────────────────────┐
│  Browser                                             │
│  index.html · script.js · styles.css                 │
│  • welcome → task → bank → readings → chamber → drafting │
│  • localStorage persistence per question             │
│  • client-side print → Save as PDF                   │
└──────────────┬───────────────────────────────────────┘
               │
       static  │  /data/questions.json     (102 questions)
       fetch   │  /data/readings.json      (per-Q readings + dialectic)
               │  /readings/<basename>.pdf (committed PDFs)
               │
       function│  POST /api/chat      → /.netlify/functions/chat
       call    │  POST /api/feedback  → /.netlify/functions/feedback
               ▼
┌──────────────────────────────────────────────────────┐
│  Netlify Functions (Node 20, ESM)                    │
│  netlify/functions/chat.js                           │
│  netlify/functions/feedback.js                       │
│  netlify/functions/_shared/lab.js                    │
│    • loadClusterPack(): reads data/packs/<id>.txt    │
│    • buildChamberMessages(): system prompt + corpus  │
│    • buildFeedbackPrompt(): rubric + exemplar + draft│
│    • rateLimitOk(): per-IP soft cap                  │
│    • estimateCostUsd(): Haiku 4.5 pricing            │
└──────────────┬───────────────────────────────────────┘
               │ Anthropic SDK over HTTPS
               ▼
┌──────────────────────────────────────────────────────┐
│  Anthropic API (claude-haiku-4-5)                    │
│  • prompt caching at the system-prompt boundary      │
│  • 5-min ephemeral cache, auto-renews on hit         │
└──────────────────────────────────────────────────────┘
```

## Prompt assembly

### `/api/chat`

The Chamber's prompt is built per request from three pieces:

```
system = [
  { type: "text", text: <generic Chamber instructions ~500 tok> },
  { type: "text",
    text: "--- CURATED READINGS (cluster: <name>) ---\n\n" + <cluster corpus>,
    cache_control: { type: "ephemeral" } }
]
messages = [
  { role: "user",      content: "My SACE Issues Study question is:\n\n> <text>\n\n…" },
  { role: "assistant", content: "Understood. What's on your mind?" },
  …last 12 turns of the student's history…,
  { role: "user", content: <new message> }
]
```

The cache-control flag goes on the *last system block* — the corpus —
which is identical across every question that maps to the same cluster.
Two students working on different questions in the same cluster reuse
each other's cache entry.

The student's question text lives in the **first user message**, not in
`system`, so a question switch within a cluster doesn't invalidate the
cached prefix.

### `/api/feedback`

No caching. The full prompt is built fresh per call (the rubric and
exemplar text are short, the draft is unique to this student, and we
won't re-feed an identical prefix). Structure:

```
You are a SACE Stage 2 Philosophy moderator…

THE STUDENT'S QUESTION: <text>
THE TASK SHEET: <task_sheet from extracted_docx>
THE SACE ASSESSMENT ADVICE: <rubric from extracted_docx>
REFERENCE EXEMPLAR — graded <A-|B|C+> by SACE moderators:
"""<exemplar text>"""
THE STUDENT'S DRAFT: """<draft>"""

[structured-output instructions: KU1/KU2/RA1/RA2/RA3/CA1/C1-C2 + grade band + top 3 priorities]
```

Domain → exemplar mapping (carried over from the previous architecture):
- `mind_tech` → exemplar B
- `religion` → exemplar C+
- everything else → exemplar A-

## Cost mechanics (Anthropic Haiku 4.5)

| Item | Rate |
|---|---|
| Input tokens | $1.00 / MTok |
| Output tokens | $5.00 / MTok |
| Cache write (5-min ephemeral) | $1.25 / MTok (input × 1.25x) |
| Cache read | $0.10 / MTok (input × 0.1x) |

Per-call estimates with a ~50K-token cluster pack:

| Scenario | Input | Cached read | Cache write | Output | Cost |
|---|---:|---:|---:|---:|---:|
| Cold-start chat (first message, writes cache) | ~50K | 0 | 50K | ~600 | ~$0.07 |
| Warm chat (cache hit within 5 min) | ~200 | 50K | 0 | ~600 | ~$0.008 |
| Feedback (no caching) | ~25K | 0 | 0 | ~1500 | ~$0.033 |

For a 14-student / 5-week cohort with active classroom use (~80% cache
hit rate during sessions), expect ~$30–50 in total spend. The hard cap
on the API key is $20/month — close to the line, so if the bill starts
to exceed plan, drop chat output to 600 tokens or trim the largest
clusters further.

## Reading content

`data/packs/<cluster_pack>.txt` is the canonical corpus the Chamber
reads from. Built once by `build_packs.py`, which:

1. For each of the 14 clusters, gathers the unique reading basenames
   from `pack_metadata.json` whose questions map to that cluster.
2. For each basename, prefers `text_packs/<basename>.txt` (already
   plain-text); falls back to `readings/<basename>.pdf` extracted via
   PyMuPDF.
3. Concatenates with stable `=== filename ===` headers.

Three clusters exceed Claude's 200K context window without trimming:
Love (~310K tokens), Civic (~267K), Free Will (~249K). These need
manual pruning when the build runs — `build_packs.py` reports the
oversized packs but doesn't auto-truncate (silent truncation would lose
specific readings the dialectic depends on).

## Persistence

- **Server-side**: none. Functions are stateless.
- **Client-side**: `localStorage` keyed by question id. Holds chat
  history, draft text, last feedback, and the SACE exemplar that was
  used. Restored on page reload.
- **Audit log**: every Function call logs to Netlify's function log
  with question id, duration, token usage, estimated cost. Pull with
  `netlify functions:log <name>`.

## Security / abuse surface

- API key lives in Netlify env vars only. Never committed.
- `.env` is gitignored for local development.
- `_shared/lab.js` rate-limits per-IP at 30 requests/hour per warm
  container. This is best-effort (concurrent invocations on different
  containers don't share state); the $20/month spend cap on the API
  key is the hard backstop.
- The Chamber's system prompt explicitly refuses essay-writing
  requests and prefill attempts.

## Known limitations

1. **Cluster context limit**: 3 of 14 clusters exceed Haiku's 200K
   context until manually trimmed.
2. **Rate limit is soft**: A determined abuser could spread requests
   across enough containers to bypass the 30/hr cap. Real protection is
   the $20/month spend cap, which simply stops the service when hit.
3. **5-minute cache TTL**: Idle gaps over 5 min force a cache rewrite
   on the next request (~$0.07 per cluster). For a heavily idle class,
   1-hour cache would amortise better, but the cap-conscious default is
   5-min.
4. **Big-reading PDFs not downloadable**: students see the 39 big
   readings in the readings list but their links resolve to plain
   `.txt` files (the text_pack), not the original PDFs. Acceptable for
   the Chamber's purposes; UX can be improved later by embedding the
   text in a styled viewer.
