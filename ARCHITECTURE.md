# Issues Study Lab -- Architecture

**Status:** MVP, first session, 2026-04-27
**Scope:** 5 sample questions, single user, localhost only

## Why a local Flask server (not the MCP server, not Cloud Run)

The MCP server (`~/.mcp-servers/ai-image/server.py`) only speaks the MCP
protocol over stdio inside Claude Code. A browser cannot call it. We need
the Lab UI to run in Chrome, hitting an HTTP API that brokers calls to
Vertex AI.

I looked at three options:

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Use MCP via Claude Code | Already exists, no new code | Browser can't call MCP; UX would be a chat box not a study tool | ✗ |
| Local Flask broker | Same SDK + auth as MCP; full control of prompt assembly; runs offline; no deployment overhead | One more server to keep running; not multi-user | ✓ for MVP |
| Cloud Run + IAP | Multi-user; persistent; no localhost dependency | Significant deployment work; auth setup; cost; out of scope for MVP | Deferred |

The Flask broker shares both the auth path (service-account JSON at
`~/.mcp-servers/ai-image/service-account.json`) and the model client
(`google.genai` Vertex Full mode) with the MCP server. So a question that
works through `chat_with_unit_pack` in Claude Code will produce equivalent
output through `/api/chat` in the Lab.

If a future session needs multi-user / off-laptop access, Cloud Run is
the natural next step -- the Flask app translates cleanly because it
already isolates env-driven config from request handling.

## Components

```
┌────────────────────────────────────────────┐
│  Chrome (localhost:5050)                   │
│  index.html · script.js · styles.css       │
│  ┌─────────┬───────────┬──────────────┐    │
│  │ Question │   Chat    │   Draft +   │    │
│  │ selector │  panel    │  Feedback   │    │
│  └─────────┴───────────┴──────────────┘    │
└──────────────┬─────────────────────────────┘
               │ fetch() -- JSON over HTTP
               ▼
┌────────────────────────────────────────────┐
│  Flask: lab/server.py (localhost:5050)     │
│  ┌──────────────────────────────────────┐  │
│  │ GET  /                -- index.html   │  │
│  │ GET  /<file>          -- static       │  │
│  │ GET  /api/questions   -- bank list    │  │
│  │ POST /api/readings    -- pack contents│  │
│  │ POST /api/chat        -- cached gen   │  │
│  │ POST /api/feedback    -- rubric grade │  │
│  └──────────────────────────────────────┘  │
└──────────────┬─────────────────────────────┘
               │ google.genai (Vertex Full)
               ▼
┌────────────────────────────────────────────┐
│  Google Vertex AI (us-central1)            │
│  · gemini-2.5-pro with cached_content for  │
│    /api/chat (90% input-token discount)    │
│  · gemini-2.5-pro plain for /api/feedback  │
│  Project: gen-lang-client-0274569601       │
└────────────────────────────────────────────┘
```

## Files

```
lab/
├── server.py              Flask broker: 4 endpoints + static
├── index.html             Single-page UI (3 panels)
├── script.js              Vanilla JS: fetch wrappers + DOM
├── styles.css             Minimal layout + token-friendly type scale
├── lab_corpus.json        Pack definitions consumed by cache_unit_pack
├── pack_metadata.json     Per-question display metadata + reading lists
├── cache_handles.json     question_id → cache_name registry (post-build)
├── unit_corpus_state.json Source of truth for cache handles (MCP writes)
├── extracted_docx/        Plain-text exemplars + rubric for feedback
│   ├── exemplar_a_minus.txt
│   ├── exemplar_b.txt
│   ├── exemplar_c_plus.txt
│   ├── assessment_advice.txt
│   ├── subject_outline.txt
│   ├── task_sheet.txt
│   └── _index.json
├── text_packs/            PDFs whose text was extracted to fit cache size
├── server.log             Per-request log of bodies, durations, token use
├── screenshots/           Manual end-to-end test captures
├── test_transcripts/      JSON of automated chat + feedback runs
├── ARCHITECTURE.md        This file
├── README.md              Launch + test instructions
├── NEXT_STEPS.md          Follow-up work for sessions 2-4
└── BUILD_REPORT.md        What was built, what wasn't, what cost
```

## Prompt assembly

### `/api/chat`

The cache already encodes a per-question system instruction (see
`lab_corpus.json` → packs[lab_q00X].system_instruction). At request time
we send only the user's message and prior history as `contents`. The cached
material plus the system instruction stay on Google's side.

History format on the wire matches Gemini's `Content` shape:

```json
{
  "history": [
    {"role": "user", "parts": [{"text": "..."}]},
    {"role": "model", "parts": [{"text": "..."}]}
  ],
  "message": "what does Bostrom say about superintelligence?"
}
```

### `/api/feedback`

Uses no cache. The full prompt is built fresh per call with:

- The student's question (looked up from `cache_handles.json`)
- The 7-criterion rubric extracted from `assessment_advice.txt`
- The closest exemplar's full text (mapping below)
- The student's draft

Exemplar mapping for MVP:

| Question domain | Exemplar used | Reason |
|---|---|---|
| `mind_tech` (Q5 -- phil zombies) | Student 3 (B) | Same question -- direct comparison |
| All others (Q1-Q4) | Student 1 (A-) | Highest-grade SACE-supplied exemplar, demonstrates target dialectical structure |

For sessions 2+ this should become a domain-aware mapper that pulls
relevant *passages* rather than whole exemplars (whole-exemplar prompts
push us close to the input-token sweet spot).

## Auth + billing

Service account: `~/.mcp-servers/ai-image/service-account.json` (project
`gen-lang-client-0274569601`, region `us-central1`). Same rail as the MCP
server's `vertex_full_client`. Credits apply: "Trial credit for GenAI
App Builder" + "GCP Free Credit". Cost characteristics for the MVP:

- Cache build (one-time, all 5 packs): $0.20-0.40 each → ~$1.50 total
- Cache storage: ~$0.14/day across all 5 caches (576k tokens × $0.01/M/h × 24h)
- Chat call: ~$0.001-0.01 each (cached input at 10%, output at full Pro)
- Feedback call: ~$0.02-0.05 each (no cache; ~15-25k input tokens)

Five cached packs storing for 70 days = ~$10 in storage, well under the
$400 promo pool.

## Logging

Every API call writes a single JSON line to `lab/server.log` with:
- timestamp
- endpoint
- request body (truncated to 4 KB)
- response duration (ms)
- token usage (from `usage_metadata`) when available
- estimated USD cost

The log is plain JSONL so it can be loaded with `pandas.read_json(lines=True)`
for ad-hoc cost / latency analysis later.

## CORS / security

CORS is allowed only from `http://localhost:5050` and `http://127.0.0.1:5050`.
The server binds to `127.0.0.1` (loopback only); it will not accept
connections from the LAN. The service-account JSON is read from
`~/.mcp-servers/ai-image/service-account.json` -- never echoed in
responses, never logged.

## Known limitations (intentional for MVP)

1. No auth -- single user, single laptop. Anyone with network access to
   `127.0.0.1` could hit the API; on a personal machine that's nobody.
2. No persistence -- chat history is held client-side only and lost on
   page reload.
3. No cache rebuild path -- if a cache expires mid-session the chat
   endpoint will fail. The 70-day TTL makes this unlikely for a single
   teaching unit; future sessions should add an auto-rebuild path
   modelled on `chat_with_unit_pack`.
4. 5 questions only -- full bank is ~110 questions; scaling needs the
   GCS-upload path (some books are 30+ MB, can't fit inline).
5. No streaming -- replies arrive all at once. UX-wise OK for MVP since
   answers are typically <400 tokens.
