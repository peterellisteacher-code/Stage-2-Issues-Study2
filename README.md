# Issues Study Lab -- Local launch

## What this is

A local web tool for SACE Stage 2 Philosophy students working on the
Issues Study (AT3 Investigation). The student picks a question, chats
with a Vertex-AI-cached library of relevant philosophy texts, drafts
their response, and asks for criterion-referenced feedback against the
SACE rubric and the closest SACE-supplied exemplar.

This is the MVP -- 5 sample questions, runs on `localhost:5050` only,
single-user. Full bank and deployment notes are in `NEXT_STEPS.md`.

## Run it

```sh
cd "C:/Users/Peter Ellis/OneDrive/Teaching/2026/12PHIL - 2026/Issues Study/lab"
python server.py
```

Then open <http://localhost:5050> in Chrome.

The server binds to `127.0.0.1:5050` (loopback only). Stop it with
Ctrl-C.

## What you'll see

Three panels:

- **Left** -- pick one of 5 sample questions. The card shows the domain
  and suggested philosophers; the list below is the curated readings
  cached against this question (`[txt]` flag means the original PDF
  was too big and a text-extracted version was cached instead).

- **Middle** -- chat panel. Send messages to the cached library. The
  reply cites the cached texts. Useful prompts:
  - "Walk me through the strongest position."
  - "What would Kant say in objection?"
  - "Quote a passage from {filename} that supports …"
  - "What's the weakest move in Bostrom's argument?"

- **Right** -- paste a draft (≥ 200 chars). Click *Get feedback*. The
  server sends the draft + the SACE rubric + the closest exemplar to
  Gemini Pro and returns structured KU/RA/CA/C feedback with a
  predicted grade band.

## Sample questions in this MVP

| ID | Domain | Question |
|---|---|---|
| `lab_q001` | Ethics | Is the rapid development of Artificial Intelligence morally justifiable? |
| `lab_q002` | Metaphysics | Is the self an illusion? |
| `lab_q003` | Epistemology | What a culture deems "common sense" is mostly ideology, not knowledge. |
| `lab_q004` | Political | To what extent is democracy the most appropriate form of government? |
| `lab_q005` | Mind / Tech | Is it possible for philosophical zombies to exist? |

## Files

`ARCHITECTURE.md` -- design notes, prompt assembly, billing.
`server.py` -- Flask broker, 4 endpoints.
`index.html` / `script.js` / `styles.css` -- frontend.
`lab_corpus.json` -- pack definitions consumed by `cache_unit_pack`.
`cache_handles.json` -- question → cache_name registry (post-build).
`pack_metadata.json` -- readings + skipped files per question.
`extracted_docx/` -- exemplar + rubric plain-text used by feedback.
`text_packs/` -- text-extracted versions of large PDFs (book-length).
`server.log` -- JSONL of every request: body, duration, token usage, cost.
`screenshots/` -- manual end-to-end capture for each question.
`test_transcripts/` -- automated harness output per question.

## Requirements

- Python 3.10+
- `flask`, `flask-cors`, `google-genai`, `python-docx`, `PyMuPDF` (`fitz`)
- Service-account JSON at `~/.mcp-servers/ai-image/service-account.json`
- Existing context caches built via `cache_unit_pack` (already done in
  the build session -- handles in `cache_handles.json`)

## Costs (per session)

- Chat call: ~$0.001-0.01 each (cached input at 10%, output at full Pro)
- Feedback call: ~$0.02-0.05 each (no cache; rubric + exemplar + draft)
- Cache storage (5 packs, 70-day TTL): ~$0.14/day until they expire
- Hourly student session of ~30 chats + 3 drafts: well under $1

Run `python server.py` and watch `server.log` to see live token + USD
estimates per request.

## Stopping for the session

`Ctrl-C` stops the Flask server. The caches stay live on Google's side
for 70 days regardless. To rebuild a cache earlier (e.g. you edited
`lab_corpus.json`), call `cache_unit_pack` again in Claude Code with the
same `pack_name`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `service-account.json not found` on startup | Confirm it sits at `~/.mcp-servers/ai-image/service-account.json` |
| Chat returns "model call failed" with `NOT_FOUND: cached content` | Cache expired (>70 days) -- rerun `cache_unit_pack` for that pack |
| Feedback blank or short | Draft too short or rubric/exemplar text missing -- check `lab/extracted_docx/` |
| 5050 already in use | Edit the `app.run(port=…)` line in `server.py` |
