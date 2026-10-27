# Code Mode savings: eight live runs, read together (2026-10-27)

**LIVE.** Real NVIDIA calls (`nvidia/nemotron-3.5-lightning-30b-a3b`), the owner's skill and read tools, synthetic data
through Zetaris. Each run asks the same three questions once per arm (`scripts/measure-codemode.ts`). Nothing was sent to
anyone. Every run's own report is in this folder, unedited:

| Run | Report | What changed before it |
|---|---|---|
| 1 | `codemode-savings-2026-10-27.md` | first run |
| 2 | `codemode-savings-2026-10-27-0347.md` | the tool loop asks for its answer on its last turn; the source-server race fixed; metric tools list their exact ids |
| 3 | `-0349.md` | the metric tools say "find a metric by its id, never by its label" |
| 4 | `-0352.md` | metrics come back keyed by id (`metrics["m:salon.no_shows.count"]`) |
| 5 | `-0357.md` | the reply step gets one correction round when a number is not in the facts (as the worker now does); the two total-revenue labels say "all lines" / "all services" |
| 6 | `-0400.md` | a script sent as one JSON-escaped string is unescaped |
| 7 | `-0404.md` | Code Mode's script step with reasoning **on** |
| 8 | `-0407.md` | same as 7 |

Run 1 does not compare like for like (the tool loop never answered), so it is left out of the totals below.

## Tokens: confirmed

| Runs | Code Mode tokens (3 questions) | Tool loop tokens | Code Mode saved |
|---|---|---|---|
| 2 | 9,086 | 73,442 | 87.6% |
| 3 | 9,160 | 78,856 | 88.4% |
| 4 | 9,139 | 69,709 | 86.9% |
| 5 | 13,705 | 71,264 | 80.8% (two scripts failed; their tokens still count) |
| 6 | 13,819 | 51,747 | 73.3% (one tool-loop question hit an NVIDIA 502) |
| 7, reasoning on | 14,924 | 70,030 | 78.7% |
| 8, reasoning on | 15,821 | 71,307 | 77.8% |

Code Mode used **73–88% fewer tokens in every run**, and about two thirds fewer model calls. The saving comes from
input: the tool loop re-sends every full tool result on every round; Code Mode sends one script's small result once.

## Accuracy: Code Mode was less reliable with this small model

A "clean" answer answered the question, and every number in it traces to what the read tools returned (checked by the
script against the read tools called directly, with no model in between).

| | Clean answers |
|---|---|
| Code Mode, reasoning off (runs 2–6) | **5 of 15** |
| Code Mode, reasoning on (runs 7–8) | **4 of 6** |
| Tool loop (runs 2–8) | **20 of 21** (the other was an NVIDIA HTTP 502, not a wrong answer) |

What went wrong in Code Mode, by kind:
- **The script read the wrong metric** (most often on "which salon service earned most": it matched labels, or counted
  total salon revenue as a service; once it reported 0 no-shows when there were 5). Listing the ids and keying the
  result by id fixed the label matching; the "total counted as a service" error remained, with reasoning on too.
- **The reply step invented figures when the facts were empty** (no proposal yet came back as made-up percentages),
  sometimes even after a correction round.
- **The script could not be read** (sent as one escaped string, twice in a row in run 5). Fixed in `extractScript`.

## What the worker does about it

- The worker never texts a number that is not in its lookup's result: the reply is traced, gets one correction round,
  and if it still fails the person gets the facts as they are ("Here's what I found: ...").
- That check cannot catch a **real number read for the wrong question** (a total presented as one service). That is
  the remaining risk in Code Mode answers.
- The worker's Code Mode script step now runs with **reasoning on** (`CODE_THINKING=off` turns it off). It was right
  more often (4 of 6 against 5 of 15), still about 78% cheaper than the tool loop, but slower: about 35 seconds a
  question instead of about 10. The text already gets "Working on it" from the webhook at once.

## Read with care

Three questions, eight runs: samples, not averages. The tool loop's last-turn rule and the reply correction round were
added during this series, and both arms always saw the same model, skill and tools. The plan writer and the HQ
Manager's digest are not measured here.
