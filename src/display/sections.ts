import type { CaseResult, EvaluationCase } from '../evaluation/index.ts';
import { candidatePrompt } from '../prompts/index.ts';

import type { ResultSection, VerdictItem } from './types.ts';

/** Content is shared by the plain printer and interactive view; neither changes grading. */
export function resultSections(
  entry: EvaluationCase,
  result?: CaseResult,
  loadedSkill?: string,
): ResultSection[] {
  const sections: ResultSection[] = [
    { id: 'scenario', title: 'Scenario', text: entry.prompt, collapsed: false },
    result?.response !== undefined
      ? { id: 'response', title: 'Operator response', text: result.response, collapsed: false }
      : {
          id: 'response',
          title: 'Operator response',
          text:
            result?.error_stage === 'candidate'
              ? '(none; operator error)'
              : '(awaiting operator response)',
          collapsed: false,
          placeholder: true,
        },
    {
      id: 'verdict',
      title: 'Grader verdict',
      text: verdictText(result),
      collapsed: false,
      ...(result ? {} : { placeholder: true }),
    },
  ];

  if (result?.judgment !== undefined && result.status === 'error') {
    sections.push({
      id: 'raw-judgment',
      title: 'Raw judgment (unvalidated)',
      text: result.judgment,
      collapsed: true,
    });
  }

  const skill = result?.skill_instructions ?? loadedSkill;
  const input =
    result?.candidate_input ??
    (loadedSkill === undefined ? undefined : candidatePrompt(entry, loadedSkill));
  sections.push(
    skill !== undefined
      ? { id: 'skill', title: 'Loaded skill', text: skill, collapsed: true }
      : {
          id: 'skill',
          title: 'Loaded skill',
          text: '(skill not stored separately; inspect the exact operator prompt)',
          collapsed: true,
          placeholder: true,
        },
    input !== undefined
      ? { id: 'input', title: 'Exact operator prompt', text: input, collapsed: true }
      : {
          id: 'input',
          title: 'Exact operator prompt',
          text: '(exact prompt not recorded yet)',
          collapsed: true,
          placeholder: true,
        },
  );

  return sections;
}

/** Only scored results have verdict items; errors stay unscored and raw judgment is never promoted. */
export function verdictItems(result: CaseResult): VerdictItem[] {
  if (result.status === 'error') return [];
  return (result.assertions ?? []).map((assertion) => ({
    id: assertion.id,
    text: assertion.text,
    required: assertion.required,
    passed: assertion.passed,
    reason: assertion.reason,
    ...(assertion.evidence.trim()
      ? { evidence: assertion.evidence }
      : {
          note:
            !assertion.required && assertion.passed
              ? 'none; judge found the prohibited behavior absent'
              : 'none quoted',
        }),
  }));
}

function verdictText(result?: CaseResult): string {
  if (!result) return '(not graded yet)';
  if (result.status === 'error')
    return `ERROR — unscored (${result.error_stage ?? 'execution'})\n${result.error ?? 'No error details recorded.'}`;
  return verdictItems(result)
    .map((item) => {
      const evidence =
        item.evidence !== undefined
          ? item.evidence
              .split('\n')
              .map((line) => `  > ${line}`)
              .join('\n')
          : `  (${item.note})`;
      return (
        `${item.passed ? 'PASS' : 'FAIL'} ${item.id} — ${item.required ? 'Must' : 'Must not'}:\n` +
        `${item.text}\nReason:\n  ${item.reason}\nEvidence:\n${evidence}`
      );
    })
    .join('\n\n');
}
