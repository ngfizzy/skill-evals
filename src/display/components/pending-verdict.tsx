import type { ReactNode } from 'react';

import type { EvaluationCase, EvaluationPhase } from '../../evaluation/index.ts';
import { singleLine, terminalText } from '../../utils/index.ts';
import { useTheme } from '../hooks/use-theme.ts';
import { BOLD, ink } from '../theme.ts';
import type { CaseState } from '../view-model.ts';

import { Notice } from './notice.tsx';

interface PendingVerdictProps {
  criteria: EvaluationCase['criteria'];
  state: CaseState;
  phase?: EvaluationPhase | undefined;
}

export function PendingVerdict({ criteria, state, phase }: PendingVerdictProps): ReactNode {
  const { colors } = useTheme();

  const notice =
    state === 'running' && phase === 'judge' ? (
      <Notice
        icon="◐"
        tone="accent"
      >{`The grader is checking the response against ${criteria.length} ${criteria.length === 1 ? 'criterion' : 'criteria'}.`}</Notice>
    ) : state === 'not-run' ? (
      <Notice icon="◌" tone="muted">
        Not graded. The run stopped before this case.
      </Notice>
    ) : (
      <Notice icon="○" tone="muted">
        Grading starts after the operator responds.
      </Notice>
    );

  return (
    <box flexDirection="column" flexShrink={0}>
      {notice}
      <text wrapMode="none" marginTop={1} {...ink(colors.muted, BOLD)}>
        Criteria to check
      </text>
      {criteria.map((criterion) => (
        <text key={criterion.id} wrapMode="word">
          <span {...ink(colors.muted)}>○ </span>
          <span {...ink(undefined, BOLD)}>{singleLine(criterion.id)}</span>
          <span {...ink(colors.muted)}>{` · ${criterion.required ? 'Must' : 'Must not'}  `}</span>
          {terminalText(criterion.text)}
        </text>
      ))}
    </box>
  );
}
