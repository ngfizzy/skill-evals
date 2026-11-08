import type { ReactNode } from 'react';

import type { CaseResult, EvaluationCase, EvaluationPhase } from '../../evaluation/index.ts';
import type { CaseState } from '../view-model.ts';

import { ErrorVerdict } from './error-verdict.tsx';
import { GradedVerdict } from './graded-verdict.tsx';
import { PendingVerdict } from './pending-verdict.tsx';

export function VerdictBody({
  entry,
  result,
  state,
  phase,
}: {
  entry: EvaluationCase;
  result?: CaseResult | undefined;
  state: CaseState;
  phase?: EvaluationPhase | undefined;
}): ReactNode {
  if (!result) return <PendingVerdict criteria={entry.criteria} state={state} phase={phase} />;
  if (result.status === 'error') return <ErrorVerdict result={result} />;

  return <GradedVerdict result={result} />;
}
