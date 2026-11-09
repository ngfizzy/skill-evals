# Reports and grading

A JSON report starts before the first candidate call and is atomically updated after every completed
case. Every snapshot contains `summary.pending`, so a crash or interruption remains distinguishable
from a completed run. An abrupt kill or power loss may leave the previous completed snapshot; it
never creates a partially rewritten JSON report. Graceful SIGINT/SIGTERM adds `interrupted` and
omits `finished_at`. The active case may be retained as an execution error.

## Console results

Automatic TTY colors distinguish passes (green), failures (red), unscored errors (magenta) and
interrupted runs (amber). Status words remain visible without color. A transient stderr line shows
case completion, current phase and elapsed time. Redirected output uses plain phase-change lines
instead of cursor controls. `--color`, `--progress`, `--width` and `--ui` affect presentation only.

Each completed case shows its title, scenario, operator response, and all validated assertions,
including every passing reason and evidence quote. Interactive terminals keep the loaded skill and
exact prompt collapsed by default, independently expandable. Plain output references them in the
report; `--full-input` includes the exact prompt. The input block contains the evaluation
instructions, selected skill/dependency bundle and scenario in the same string passed to the
candidate adapter. It is not just the scenario. Grading criteria are sent separately to the judge.
Each assertion shows `PASS` or `FAIL`, `Must` or `Must not`, its full criterion, the judge's reason
and the supporting response quote. A passing `Must not` criterion means prohibited behavior is
absent. If its evidence is empty, the output explicitly identifies the absence judgment instead of
inventing a quote. Other empty evidence is shown as none quoted.

Errors show the candidate, judge or grading stage and the recorded error, plus raw unvalidated judge
text when available; unvalidated judgments are never presented as passed assertions. Existing case
scores, final counts, grading and exit semantics remain the same. Input and model text are indented
and terminal control characters are escaped for display, including bidi overrides; the JSON report
retains the original text. Keep console recordings private too.

## Fields

| Field                                        | Meaning                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `version`                                    | Report structure version, currently `1`                           |
| `mode`                                       | `response-only`                                                   |
| `evaluation_protocol`                        | `response-decisions-v4`                                           |
| `started_at`, `finished_at`                  | UTC timestamps; finish absent on interruption                     |
| `agent_version`                              | Actual preflight Codex version                                    |
| `model`, `judge_model`                       | Explicit candidate and judge identities                           |
| `reasoning_effort`, `judge_reasoning_effort` | Explicit per-session effort                                       |
| `context`                                    | Requested full or focused reference selection                     |
| `timeout_seconds`                            | Bound for each candidate or judge call                            |
| `selected_cases`                             | Filtered, limited live batch size                                 |
| `git_sources`                                | Optional HTTPS repository URLs and resolved commits in root order |
| `results`                                    | Completed results in execution order                              |
| `summary`                                    | Passed, failed, errors, pending and aggregate assertion score     |

Each result includes the case key, skill, ID, title, scenario as `prompt`, criteria, source path and
`source_sha256` of the raw eval source. `skill_sha256` hashes the exact bundled instruction string.
These fingerprints identify inputs; they do not promise deterministic model outputs. Results also
retain the candidate `context_mode` (full, focused or full-fallback), `context_bytes`,
`candidate_input` (the exact prompt string sent to the candidate adapter), `response`, raw
`judgment`, validated `assertions`, status and score when available. New results also include
`skill_instructions`, the exact resolved bundle supplied to operator and grader. The viewer can
expand this field without parsing prompt headings. Its hash is still `skill_sha256`; neither model
prompt nor protocol changes. Earlier reports without this field identify that limitation and offer
the exact prompt instead. The viewer supports protocol v3/v4 version 1 reports; it validates saved
data before displaying it and never rewrites it. Pending counts remain visible, even when a partial
report has no completed case details.

For a Git case, `source` has the form
`git+https://HOST/OWNER/REPO.git#COMMIT:skills/NAME/eval.yaml`. The report records all supplied Git
snapshots in `git_sources`, even when a root only supplies dependencies. Reuse a recorded commit as
the revision in `--root` to pin a subsequent run. Saved reports, including reports written before
Git roots were supported, replay without Git or network access.

Earlier reports may omit `candidate_input`; their `prompt` remains the scenario only. New results
retain the attempted input even when the candidate call fails.

An error preserves already collected response/judgment text and adds `error` and `error_stage`
(`candidate`, `judge` or `grading`). Setup/preflight errors exit `2` before a report is created. A
report write failure exits `2`; the last completed snapshot remains authoritative and can still show
pending cases.

## Deterministic grading checks

The judge receives the candidate's exact resolved instruction bundle as `skill_instructions` in its
JSON evaluation data, alongside `scenario`, `response`, `response_segments` and `criteria`. The
bundle includes the same dependencies and full or focused references selected for that case; the
judge does not reload a broader bundle. It uses the skill as reference context for each explicit
criterion. Skill text is evaluation data, not instructions for the judge to execute or authority to
change its role, rubric or evidence rules. Only the supplied criteria are scored; unrelated skill
rules do not add checks.

Protocol v4 adds this reference context. Protocol v3 reports used the same evidence-ID format but
their judges did not receive the skill bundle. Preserve that distinction when comparing results. The
report structure stays at version 1, and `skill_sha256` now identifies the bundle supplied to both
participants.

A judgment must contain only an `assertions` array with every expected criterion ID exactly once.
Each item must have exactly `id`, Boolean `passed`, nonempty `reason`, and an `evidence_ids` array.
The judge receives numbered response lines as `response_segments` and selects their IDs. The runner
derives `evidence` from the original text, preserving Markdown and punctuation. A passing positive
criterion needs nonblank evidence; absence checks and failed criteria may use an empty selection.
Unknown, duplicate or non-string evidence IDs are errors. Reconstructed evidence is cumulatively
bounded to 2 MiB per case, checked before joining selected lines; exceeding it is an unscored
grading error and preserves the response/judgment without expanded assertions. This prevents many
criteria from duplicating a large segment without bound. The evidence-ID format introduced in v3
replaces protocol v2's judge-written quote field; old report artifacts remain inspectable as JSON
but v2 judge output is rejected rather than silently converted.

Invalid JSON, missing/duplicate/unexpected IDs, invalid evidence IDs and malformed fields produce an
unscored error. Valid case scores are the proportion of passing criteria. A case passes only when
every criterion passes. The aggregate `assertion_score` weights all assertions across successfully
graded cases; errors are excluded and an entirely ungraded batch has a null score.

## Interpretation

Action criteria measure the proposed actions, checks, ordering and authorization in a simulated
response. They do not require tool execution. Supplied mock facts are accepted as fixtures; an
available record does not supply its contents. Invented facts and unsupported claims of completed
real actions should fail. Passing means the response satisfies the explicit criteria with skill
context; it does not prove every rule in the skill was tested. Quoted evidence and schema validation
establish grading structure, not semantic truth. Judge inconsistency remains possible. Preserve
reports across repeats and report pass, fail and error counts separately.

Reports are private artifacts: they may contain source locations, full skill instructions and model
text. Never commit real reports into a distributable skill or package.
