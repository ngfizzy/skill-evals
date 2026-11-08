import type { RunDisplay } from '../display/index.ts';
import type { Judge } from '../judge/index.ts';
import type { Operator } from '../operator/index.ts';
import type { ReportCheckpoint, ReportWriter } from '../report/index.ts';

import type { EvaluationOrchestrator } from './orchestrator.ts';
import type { CaseResult, EvaluationCase } from './schemas.ts';

export type EvaluationPhase = 'candidate' | 'judge';

export interface PreparedCase {
  entry: Readonly<EvaluationCase>;
  bundle: string;
  contextMetadata: Required<Pick<CaseResult, 'context_mode' | 'context_bytes'>>;
}

export interface EvaluationRoles {
  operator: Pick<Operator, 'respond'>;
  judge: Pick<Judge, 'judge'>;
}

export interface EvaluateOptions {
  signal?: AbortSignal;
  onPhase?: (phase: EvaluationPhase) => void;
}

export interface EvaluationRunnerDependencies {
  orchestrator: Pick<EvaluationOrchestrator, 'evaluate'>;
  writer: Pick<ReportWriter, 'write'>;
  display: Pick<RunDisplay, 'phase' | 'caseSaved'>;
}

export interface EvaluationRunOptions {
  cases: readonly PreparedCase[];
  initialCheckpoint: ReportCheckpoint;
  signal: AbortSignal;
}
