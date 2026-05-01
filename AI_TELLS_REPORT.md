# AI Tells Report -- Build Documentation

**Scanned:** ARCHITECTURE.md · README.md · NEXT_STEPS.md · BUILD_REPORT.md
**Reference:** `~/.claude/skills/ai-tells-checker/references/core-tells.md` (22 tells)
**Voice authority:** `~/.claude/skills/personal-humanizer/references/peters-voice.md` and `feedback_voice_ai_tells.md` memory

## Verdict -- clusters by tell

| Tell | Confidence | Where | Count |
|---|---|---|---|
| **5 -- Em-dash overuse** | **HIGH** | All 4 docs | **104** total: ARCHITECTURE 17, README 19, NEXT_STEPS 11, BUILD_REPORT 57 |
| 1 -- Reassuring negative → positive | clean | -- | 0 |
| 2 -- Summary kicker | clean | -- | 0 (no Ultimately / Overall / In short paragraph closers) |
| 3 -- Rule of three | clean | -- | 0 inflated triplets |
| 4 -- Copula avoidance | clean | -- | 0 (no serves as / stands as / embodies) |
| 6 -- -ing tail phrases | clean | -- | 0 (no highlighting/demonstrating/etc. tails) |
| 9 -- Not just X but Y | clean | -- | 0 |
| 13 -- Phantom specificity | clean | -- | the 1 "Several books" hit is followed by named books |
| 15 -- False range from X to Y | clean | -- | 0 |
| 17 -- AI vocabulary cluster | clean | -- | 0 (no multifaceted / nuanced / pivotal / tapestry / etc.) |
| 22 -- False balance | n/a | -- | technical doc, not analytical essay |

The only HIGH-confidence pattern is em-dash overuse. The 4 docs are otherwise
free of the listed patterns.

## Why em-dashes are the betrayer here

Per `feedback_voice_ai_tells.md` (Peter's own memory entry on AI tells in
his voice): "Peter uses `--` (double hyphen), not `—`. And sparingly --
maybe once per feedback doc. I was using 3-6 proper em-dashes per doc."

In this build I used 104 em-dashes across 4 docs (~26 per doc) -- well
beyond the 3-6 range Peter caught last time, let alone his actual usage of
"sparingly." Without this fix every doc reads as AI-generated.

## Pass-2 prose audit (personal-humanizer Pass 2 checks)

| Check | Verdict | Notes |
|---|---|---|
| Summary kickers | Clean | No paragraph ends with an inflated kicker |
| Mirrored openings/closings | Clean | Section headers vary; closers vary |
| Rhetorical question chains | Clean | None |
| Personality vacuum | Mild | Most prose is technical-flat. Acceptable for a handover doc, but a few passages read assembled -- flagged below |
| Negative-positive pivots | Clean | One natural pivot per doc at most |
| Generic modelling | n/a | No student-style modelling |

### Specific prose passages flagged for rewrite

1. **NEXT_STEPS.md** -- "Why this is the next session", "Why next", "Why
   this matters" subheadings under each session block are templated.
   Peter would say the why directly, not signpost it.
2. **NEXT_STEPS.md** -- "Comfortably inside the $400 promo pool with room
   for a second cohort in 2027 before re-evaluating." -- kicker-shaped;
   the cost table already says this.
3. **BUILD_REPORT.md** -- "Substantive sanity: every chat reply opened
   with framing relevant to the question's domain..." -- slightly over-
   polished construction; "framing relevant to" reads like a stock phrase.
4. **ARCHITECTURE.md** -- "Three options were considered" passive voice;
   Peter would say "I looked at three options" or just present the table.
5. **BUILD_REPORT.md** -- "Comfortably under the $20 doubled-doubled
   budget." -- kicker-shaped one-line restatement of the table above.

## Remediation plan

1. **Mechanical:** replace every `—` with `--` across the 4 docs.
2. **Targeted prose edits** on the 5 passages above to flatten the
   templated phrasing.
3. **Re-grep** to confirm zero em-dashes remain.
4. **Save a memory entry** noting that em-dash discipline applies to my
   own technical docs in this project, not just student feedback.
