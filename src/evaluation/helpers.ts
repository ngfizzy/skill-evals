import type { JudgeOutcome } from '../judge/index.ts';
import { sha256 } from '../utils/index.ts';

import type { CaseResult } from './schemas.ts';
import type { PreparedCase } from './types.ts';

export function createCaseResult(
  { entry, bundle, contextMetadata }: PreparedCase,
  prompt: string,
): CaseResult {
  return {
    ...entry,
    ...contextMetadata,
    skill_sha256: sha256(bundle),
    candidate_input: prompt,
    skill_instructions: bundle,
    status: 'error',
    score: null,
  };
}

export function applyGrading(
  result: Readonly<CaseResult>,
  response: string,
  graded: JudgeOutcome,
): CaseResult {
  if ('error' in graded)
    return {
      ...result,
      response,
      ...('judgment' in graded ? { judgment: graded.judgment } : {}),
      error: graded.error,
      error_stage: graded.stage,
    };

  const { judgment, assertions } = graded;
  const passed = assertions.filter((assertion) => assertion.passed).length;
  return {
    ...result,
    response,
    judgment,
    assertions,
    score: passed / assertions.length,
    status: passed === assertions.length ? 'passed' : 'failed',
  };
}
