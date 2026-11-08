import type { EvaluationCase } from '../evaluation/index.ts';

export interface OperatorInput {
  entry: Pick<EvaluationCase, 'prompt'>;
  bundle: string;
  signal?: AbortSignal;
  onStart?: () => void;
}

export type OperatorOutcome = { prompt: string } & ({ response: string } | { error: string });
