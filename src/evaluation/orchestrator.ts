import { applyGrading, createCaseResult } from './helpers.ts';
import type { CaseResult } from './schemas.ts';
import type { EvaluateOptions, EvaluationRoles, PreparedCase } from './types.ts';

export class EvaluationOrchestrator {
  constructor(private readonly roles: EvaluationRoles) {}

  async evaluate(
    prepared: PreparedCase,
    { signal, onPhase }: EvaluateOptions = {},
  ): Promise<Readonly<CaseResult>> {
    const { entry, bundle } = prepared;
    const input = { entry, bundle, ...(signal ? { signal } : {}) };

    const operated = await this.roles.operator.respond({
      ...input,
      onStart: () => onPhase?.('candidate'),
    });

    const result = createCaseResult(prepared, operated.prompt);
    if ('error' in operated) return { ...result, error: operated.error, error_stage: 'candidate' };

    const { response } = operated;
    const graded = await this.roles.judge.judge({
      ...input,
      response,
      onStart: () => onPhase?.('judge'),
    });

    return applyGrading(result, response, graded);
  }
}
