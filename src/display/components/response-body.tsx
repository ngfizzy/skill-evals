import type { ReactNode } from 'react';

import type { CaseResult, EvaluationPhase } from '../../evaluation/index.ts';
import type { ResultSection } from '../types.ts';
import type { CaseState } from '../view-model.ts';

import { Notice } from './notice.tsx';
import { Quote } from './quote.tsx';

export function ResponseBody({
  section,
  result,
  state,
  phase,
}: {
  section: ResultSection;
  result?: CaseResult | undefined;
  state: CaseState;
  phase?: EvaluationPhase | undefined;
}): ReactNode {
  if (!section.placeholder) return <Quote text={section.text} />;
  if (result?.error_stage === 'candidate') {
    return (
      <Notice icon="▲" tone="error">
        No response recorded. The operator call failed; the verdict below has the details.
      </Notice>
    );
  }
  if (state === 'running') {
    return phase === 'judge' ? (
      <Notice icon="◐" tone="accent">
        Response received. It appears here with the verdict when grading completes.
      </Notice>
    ) : (
      <Notice icon="◐" tone="accent">
        Waiting for the operator's response.
      </Notice>
    );
  }
  if (state === 'not-run')
    return (
      <Notice icon="◌" tone="muted">
        Not run. The evaluation stopped before this case produced a response.
      </Notice>
    );
  return (
    <Notice icon="○" tone="muted">
      Queued. This case has not started yet.
    </Notice>
  );
}
