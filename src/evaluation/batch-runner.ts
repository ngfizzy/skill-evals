import { withSummary } from '../report/helpers.ts';
import type { ReportCheckpoint } from '../report/types.ts';

import type { EvaluationRunOptions, EvaluationRunnerDependencies } from './types.ts';

export class EvaluationRunner {
  constructor(private readonly dependencies: EvaluationRunnerDependencies) {}

  async run({ cases, initialCheckpoint, signal }: EvaluationRunOptions): Promise<ReportCheckpoint> {
    const { orchestrator, writer, display } = this.dependencies;
    let checkpoint = initialCheckpoint;

    for (const preparedCase of cases) {
      if (signal.aborted) break;
      const result = await orchestrator.evaluate(preparedCase, {
        signal,
        onPhase: (phase) => display.phase(preparedCase.entry, phase),
      });

      const nextCheckpoint = withSummary({
        ...checkpoint,
        results: [...checkpoint.results, result],
      });
      await writer.write(nextCheckpoint);
      checkpoint = nextCheckpoint;

      display.caseSaved(result, checkpoint);
    }

    const finalCheckpoint = signal.aborted
      ? { ...checkpoint, interrupted: true }
      : { ...checkpoint, finished_at: new Date().toISOString() };
    await writer.write(finalCheckpoint);
    return finalCheckpoint;
  }
}
