# Next Steps -- Issues Study Lab

The MVP shipped 5 sample questions end-to-end. This file lists the work
the next 2-4 sessions should pick up, in priority order.

## Session 2 -- Scale to the full bank (~110 questions)

The MVP only covers 5 of ~110 questions in `Question Bank.md`. Until the
full bank is cached, the Lab can't go to a real cohort. So this is next.

### Tasks

1. **Parse the full Question Bank** into `questions.json`
   - Source: `Question Bank.md` (already structured by domain)
   - Output: same shape as the 5 entries already in `cache_handles.json`,
     plus a `_unmatched` array for questions that didn't auto-classify
2. **Auto-pick readings** per question
   - Reuse the embedding pipeline from the Reading Map prompt: embed
     summaries via `embed_text_gemini`, embed each question, take top-15
     candidates, send to Gemini Pro for primary/secondary/dialectic
   - For Lab purposes we only need the *primary* list (8-12 readings)
3. **Add the GCS-upload path to `server.py`** in the ai-image MCP
   - Several full books (Hobbes *Leviathan* 30+ MB, Rawls *Theory of
     Justice*, How Propaganda Works) blow the ~8 MB inline cache limit
     even after text extraction. Some questions can't be cached without GCS.
   - Spec: upload large files to a `gs://gen-lang-...-philosophy-cache`
     bucket; reference via `Part.from_uri(file_uri=..., mime_type=...)`
     when building the `caches.create` payload
   - Documented as a known gap in `IMPLEMENTATION_GUIDE.md` Step 15
4. **Batch-cache** all 110 questions
   - Sequential `cache_unit_pack` calls (each ~30-90s); total wall time
     ~2 hours
   - Storage cost at 70-day TTL: ~$30 for the full bank; well within the
     promo pool. Set a $50 budget alarm before the batch starts.
5. **Move `cache_handles.json` generation** from hand-edited to scripted
   - Read all entries from `unit_corpus_state.json` post-batch and
     write `cache_handles.json` mechanically

## Session 3 -- Authoring + persistence

Without save/load, students lose work on every reload. That's unworkable
for a multi-week investigation, so this comes after the bank scales out.

### Tasks

1. **Local persistence via `localStorage`**
   - Keys: `lab_state_<question_id>` → `{history, draft, last_feedback}`
   - Auto-save on every chat reply + on draft input (debounced 1s)
   - Restore on `onQuestionChange` if the qid matches
2. **Export to Markdown / Word**
   - Add an *Export* button on the right panel
   - Bundle: question, chat history, final draft, latest feedback
   - Use `python-docx` server-side OR render Markdown in the browser and
     trigger download (preferred -- no server round-trip)
3. **A "session resume" panel**
   - Sidebar in left panel: list of qids the student has already worked
     on (from localStorage), with last-modified timestamp
4. **Clear / reset** controls per question

## Session 4 -- Self-check + dialectical-pressure endpoint

The A-grade exemplar's distinguishing feature is that objections live
*inside* each position, not in a separate "objections" section. The Lab
should pressure-test the student's argument before asking for feedback,
the same way Peter would in conversation.

### Tasks

1. **`POST /api/self_check`** endpoint
   - Body: `{question_id, draft_text}`
   - System prompt: "You are a Year 12 student arguing the strongest
     opposing position. For each claim in the draft, push back with the
     strongest objection grounded in the cached texts."
   - Output: list of objections with *which philosopher would raise it*
     and *which passage in the cached corpus supports the objection*
2. **`POST /api/quote_check`** endpoint
   - Body: `{question_id, claim_about_thinker, thinker_name}`
   - Returns whether the cached materials support the claim, and the
     closest verbatim quote (if any). Useful in marking phase too.
3. UI: a *Dialectical pressure* button on the right panel that runs
   `/api/self_check` and renders objections inline

## Session 4+ -- Polish and identity

1. Run `/aesthetic-identity` against the question content and see if a
   stronger visual identity emerges (current MVP uses a generic
   ink-on-cream look; pleasant but not opinionated)
2. Apply `/page-composition` audit to the layout -- confirm flexbox /
   grid usage, viewport-locked sections, type scale compliance
3. Streaming responses for `/api/chat` (Gemini supports it; current MVP
   blocks on the full reply for 30-60s on Pro)
4. Per-question "warm boot" -- preload readings + an opening greeting
   from the model when the question is first selected, so the first
   message isn't a 60s wait

## Session N -- Deployment decision

By the time the full bank is cached and persistence works, the question
becomes: keep on `localhost`, or move to Cloud Run?

**Stay local if:** Peter is the only user; only one cohort at a time;
he doesn't mind shutting his laptop = the Lab stops; service-account
JSON staying off the internet is a hard requirement.

**Move to Cloud Run if:** other teachers want access; students want to
use it from home; Peter needs the Lab running while presenting at a
conference; a Cloud Run instance idle is ~$0/month so cost is minimal.

If Cloud Run:
- Container the Flask app (existing `server.py` will work with no changes)
- Mount the service account via Workload Identity (don't bake JSON in)
- Cloud Storage for `lab_corpus.json` + `cache_handles.json` + extracted_docx
- IAP in front for "any signed-in Google user from peterellis.example.au"
- ~$0/month idle, ~$5/month under heavy use; charge against the same
  promo credits

## Cost projection -- full-scale use

Rough numbers for a class of 14 Year 12s, 5-week investigation, 1 hour/week
each, mixed chat + feedback:

| Per student per week | Calls | Avg cost | Total |
|---|---|---|---|
| Chat | 30 | $0.005 | $0.15 |
| Feedback | 2 | $0.04 | $0.08 |
| **Per student per week** | | | **$0.23** |
| **Per student over 5 weeks** | | | **$1.15** |
| **Class of 14, 5 weeks** | | | **$16** |
| Cache storage (110 packs × 70 days) | | | **~$30** |
| **Total per cohort** | | | **~$46** |

Two cohorts and the storage still leaves the $400 promo pool mostly
intact, so re-evaluation isn't urgent.

## Things deliberately NOT in the next-step list

- **Multi-language support.** AU/UK English plus the Greek/Latin terms
  in the cached texts is enough.
- **Voice input.** Year 12 students type. If a student needs voice for
  accessibility, route through the OS dictation tool, not the Lab.
- **Real-time collaboration.** Issues Study is an individual task.
  Adding shared state would invite plagiarism, not learning.
- **A grade-prediction "leaderboard."** Predicted bands are for the
  student's revision use, not for ranking. Surface them privately.
