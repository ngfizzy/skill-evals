import type { EvaluationCase } from '../evaluation/index.ts';

export function candidatePrompt(
  evaluation: Pick<EvaluationCase, 'prompt'>,
  bundle: string,
): string {
  return `Apply the supplied skill instructions to the simulated scenario below.
This is a response-only evaluation: no real tools or external actions are available.
For action-based tasks, describe the specific actions, checks, ordering, and decisions
that you would take. Use capabilities and evidence described in the scenario as
simulated prerequisites; do not ask for records solely because this evaluation
cannot open a tool that the scenario says is available. Produce requested wording
or calculations when their inputs are supplied. A record's availability does not
reveal its contents: explain how you would obtain them instead of inventing details.
If necessary evidence is unavailable or ambiguous, acknowledge the gap and preserve
the relevant boundary. Do not claim to have actually read files, run commands,
submitted anything, or changed external state. Distinguish supplied scenario facts
from actions you would take.

SKILL INSTRUCTIONS:
${bundle}

SCENARIO:
${evaluation.prompt}`;
}
