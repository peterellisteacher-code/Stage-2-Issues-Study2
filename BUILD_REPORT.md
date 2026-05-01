# Build Report -- Issues Study Lab MVP

**Built:** 2026-04-26 → 2026-04-27 (overnight session, autonomous)
**Status:** MVP working end-to-end on 5 sample questions
**Killswitch:** did not fire. Used ~$1.35 of the $20 Vertex budget; ~60 of 800 tool calls.

## What was built

A working three-panel browser app that lets a SACE Stage 2 Philosophy
student pick an Issues Study question, chat with a Vertex-AI-cached
library of relevant philosophy texts, draft a response, and request
criterion-referenced feedback against the SACE rubric and the closest
SACE-supplied exemplar.

| Component | File | Lines | Status |
|---|---|---|---|
| Pre-process + corpus build | `preprocess.py` | 200 | Ran clean; all 5 packs under 6 MB |
| Pack definitions | `lab_corpus.json` | 50 | 5 packs, gemini-2.5-pro, 70-day TTL |
| Cache handles registry | `cache_handles.json` | 65 | Populated post-build |
| Pack metadata (readings + skipped) | `pack_metadata.json` | (json) | Source for `/api/readings` |
| Flask broker | `server.py` | 280 | 4 endpoints + static; logs to `server.log` |
| Frontend | `index.html` + `script.js` + `styles.css` | 90 + 230 + 290 | Three panels; URL hash auto-select |
| End-to-end test harness | `run_tests.py` | 175 | 10 chats + 5 feedbacks across 5 questions |
| Architecture | `ARCHITECTURE.md` | (md) | Decisions, prompt assembly, billing |
| Launch + troubleshooting | `README.md` | (md) | One-page student-facing |
| Follow-ups | `NEXT_STEPS.md` | (md) | Sessions 2-4 plan |

Plus 5 screenshots in `screenshots/` (Chrome headless via URL hash) and
5 transcripts in `test_transcripts/` (each: 2 chats + 1 feedback).

## Architecture (tl;dr)

Browser → Flask broker on `127.0.0.1:5050` → `google-genai` Vertex Full
client → Gemini 2.5 Pro on `us-central1` with `cached_content=` for
chat. Same service-account JSON the ai-image MCP uses
(`~/.mcp-servers/ai-image/service-account.json`). Bills against GCP
project `gen-lang-client-0274569601` -- credits apply.

The full design rationale is in `ARCHITECTURE.md`. Key decisions:

- **Local Flask, not Cloud Run.** Cloud Run was deferred to Session N+ --
  see `NEXT_STEPS.md`. Local is the right scope for a one-laptop MVP.
- **Re-use `cache_unit_pack`** rather than reinvent caching. The pack
  format is identical to `Epistemology/unit_corpus.json`; only the
  paths and pack names differ.
- **Use absolute paths in `lab_corpus.json`** because the readings span
  two source folders (Issues Study + Philosophy Texts library). The MCP
  code resolves `corpus_root / rel`; pathlib returns the absolute path
  unchanged when `rel` is itself absolute, so this works without any
  MCP-side changes.
- **Pre-emptively text-extract any PDF over 2 MB** (`preprocess.py`).
  Three book-length texts (Hobbes *Leviathan*, Rawls *Theory of Justice*,
  How Propaganda Works, Sublime Object, Wolff *Political Philosophy*)
  needed it. Text-extracted versions live in `text_packs/`.
- **Map question → exemplar** by domain. Q5 (phil zombies) gets the
  same-question Student 3 (B) response; Q1-Q4 get Student 1 (A-) as the
  gold-standard pattern.

## The 5 sample questions

| ID | Domain | Question | Readings cached | Pack tokens |
|---|---|---|---|---|
| `lab_q001` | Ethics | Is the rapid development of Artificial Intelligence morally justifiable? | 9 | 84,199 |
| `lab_q002` | Metaphysics | Is the self an illusion? | 9 | 175,794 |
| `lab_q003` | Epistemology | What a culture deems "common sense" is mostly ideology, not knowledge. | 8 | 204,687 |
| `lab_q004` | Political | To what extent is democracy the most appropriate form of government? | 9 | 80,841 |
| `lab_q005` | Mind / Tech | Is it possible for philosophical zombies to exist? | 10 | 30,275 |
| | | | **Total** | **575,796** |

### Hand-picked readings per question

**Q1 Ethics -- AI** (suggested philosophers: Bostrom, Singer, Floridi, Kant, Rachels)
- Nick Bostrom -- *The Ethics of Artificial Intelligence*
- Bostrom and Yudkowsky -- *The Ethics of Artificial Intelligence*
- Floridi -- *The Ethics of Artificial Intelligence*
- Floridi -- Chapters 4 and 5 (text-extracted)
- Rachels -- The utilitarian approach
- Rachels -- The debate over utilitarianism
- Rachels -- Kant and respect for persons
- Rachels -- Are there absolute moral rules
- Hursthouse -- *Normative Virtue Ethics*

**Q2 Metaphysics -- Self** (Hume, Williams, Dennett, Metzinger, Plato)
- Hume -- *Empiricism* (the bundle theory section)
- Bernard Williams -- *The Self and the Future*
- Bernard Williams -- On Personal Identity Thought Experiments
- Williams handout -- Subjective experience
- Williams outline -- Expectations and the self
- Simon Beck -- Back to the Future and the self
- Daniel Dennett -- Facing up to the hard question of consciousness
- Thomas Metzinger -- *Being No One* (text-extracted; book-length)
- Plato's Theory of Forms -- *Philosophy Now*

**Q3 Epistemology -- Ideology** (Žižek, Stanley, Mills, Marx, Storey)
- Žižek -- *The Sublime Object of Ideology* (text-extracted)
- Žižek -- *Tolerance as an Ideological Category*
- Žižek -- *First as Tragedy, Then as Farce* (text-extracted)
- Stanley -- *How Propaganda Works* (text-extracted)
- An Epistemological Account of the Logic of Propaganda
- Introduction to Poststructuralism
- *Postmodernism -- A Very Short Introduction* (text-extracted)
- Rationalism vs Romanticism

**Q4 Political -- Democracy** (Plato, Hobbes, Locke, Rawls, Mill)
- Wolff -- *An Introduction to Political Philosophy* (text-extracted; book-length)
- Wolff excerpt -- Rawls VoI and OP
- Rawls -- *A Theory of Justice* (text-extracted; book-length)
- Hobbes -- *Leviathan* (text-extracted; book-length)
- Hobbes and Locke (overview)
- Rachels -- The Social Contract (book chapter)
- Scanlon -- Contractualism and Utilitarianism
- Nietzsche -- Master Morality and Slave Morality
- Rachels -- Social Contract (textbook chapter)

**Q5 Mind -- Phil Zombies** (Chalmers, Jackson, Dennett, Block, Nagel)
- Frank Jackson -- *Epiphenomenal Qualia*
- Frank Jackson -- What Mary Didn't Know
- Bacs -- Mental Fictionalism and Epiphenomenal Qualia
- Ned Block -- Wittgenstein and Qualia
- Ravenscroft -- The Identity Theory
- Ravenscroft -- Functionalism
- Princess Elisabeth's response to dualism
- Nagel -- What is it like to be a bat?
- Muller -- Why Qualia are not Epiphenomenal
- Ravenscroft -- Dualism

No readings were dropped for size; the largest pack (Q3) totalled 5.0 MB
after text extraction, well inside the 6 MB safety budget.

## End-to-end test results

`run_tests.py` ran 2 chats + 1 feedback against each question, against
the running Flask server. Transcripts live in `test_transcripts/{qid}.json`;
tally in `test_transcripts/_tally.json`.

| Question | Chat 1 (ms) | Chat 2 (ms) | Feedback (ms) | Cost (USD) | Rubric structure |
|---|---|---|---|---|---|
| `lab_q001` | 62,229 | 59,565 | 39,553 | $0.0791 | All 7 headings + grade band ✓ |
| `lab_q002` | 96,806 | 116,460 | 48,464 | $0.1364 | All 7 headings + grade band ✓ |
| `lab_q003` | 77,816 | 88,677 | 44,313 | $0.1585 | All 7 headings + grade band ✓ |
| `lab_q004` | 61,046 | 59,335 | 45,515 | $0.0747 | All 7 headings + grade band ✓ |
| `lab_q005` | 42,837 | 49,597 | 46,140 | $0.0448 | 6/7 headings -- band stated but under different label |
| **Total** | | | | **$0.4935** | 4/5 fully clean |

**Q5 minor flaw:** The model returned a complete, well-structured
critique of the B-graded zombies essay including a predicted band, but
formatted the band as a final paragraph rather than under the
`## Predicted grade band` heading the prompt asked for. The string
match in `run_tests.py` flagged this as missing; it's not actually
missing. Hardening the prompt to enforce that exact heading is a
follow-up tweak (probably worth doing in Session 2).

**Sanity check on the substance:** every chat reply opened in the right
domain and named at least one cached text. No reply invented a thinker
who wasn't in the pack. No 5xx, no truncations.

## Cost breakdown

| Line item | Tokens / events | Cost |
|---|---|---|
| Cache build (5 packs, one-time) | 575,796 input tokens × $1.25/M | **$0.72** |
| Cache storage (1 day so far) | 575,796 × $0.01/M/h × 24h | **$0.14** |
| Test harness (10 chats + 5 feedbacks) | model-reported usage | **$0.49** |
| **Total spent in this session** | | **$1.35** |

Looking forward:

- Storage going forward: ~$0.14/day for the 5 packs; ~$10 across the full
  70-day TTL if I never rebuild
- A real student session: ~$0.20 chat + $0.10 feedback, conservatively

## What was deliberately NOT built

The MVP scope from the prompt's Step 4 was respected. Items pushed to
`NEXT_STEPS.md`:

- Full 110-question bank -- only 5 are cached; the rest need GCS-upload
  for book-length texts that won't fit inline
- Save/load drafts -- chat history is in-memory and lost on reload
- Export to PDF / Markdown / submission format -- `/api/feedback`
  returns Markdown but there's no UI export button
- Authentication -- single user, localhost binding only
- Cloud Run / multi-user deployment
- Streaming chat replies -- currently blocks on full reply for ~60s
- "Self-check" / dialectical-pressure endpoint that runs the student's
  argument through the same objection-density check the A-exemplar passes

## Tool-call + budget tally

| Limit | Original | After 1st double | After 2nd double | Used |
|---|---|---|---|---|
| Vertex spend | $5 | $10 | **$20** | **$1.35** |
| Tool calls | 200 | 400 | **800** | ~62 |

Killswitch did not fire. The session completed in roughly 90 minutes
of wall time, of which ~16 minutes were the test harness running
sequentially against Vertex.

## How to verify when Peter wakes up

Per the original prompt:

```sh
cd "C:/Users/Peter Ellis/OneDrive/Teaching/2026/12PHIL - 2026/Issues Study/lab"
python server.py
```

Open `http://localhost:5050`. Pick a question. Send a chat message --
expect cited authors and quoted phrases. Paste any of the exemplars
from `extracted_docx/` into the draft panel and click *Get feedback* --
expect 7 rubric-aligned sections + a predicted band.

`test_transcripts/_tally.json` shows the exact wall times + costs from
the overnight run if you want to read transcripts before launching the
server.

`server.log` is JSONL; `python -c "import json; [print(json.loads(l)) for l in open('server.log')]"` dumps it readable.

## Known issues / sharp edges

1. **First chat call after pack build is slow** (~60-100s on Pro). Once
   warm, subsequent calls in the same minute drop to 40-60s. Streaming
   in Session 4 will mask this.
2. **The Q5 grade-band heading mismatch** (above) -- minor prompt fix.
3. **Service-account JSON read at import time.** If the file moves the
   server crashes on startup with a clear error message; no silent fallback.
4. **No graceful shutdown of the background Chrome processes** spawned
   by the screenshot harness. They exit on their own; if any linger,
   `taskkill /im chrome.exe` cleans up.
5. **Two of the cached files are duplicates with slightly different
   filenames** in the source library (`Ravenscroft - Philosophy of Mind
   Beginners Guide` appears in both `Mind Watch to Functionalism/` and
   `Metaphysics/`). Neither was selected for the MVP packs but worth
   flagging for Session 2's auto-pick pipeline.
