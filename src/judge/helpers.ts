import type { ResponseSegment } from '../evaluation/protocol.ts';
import {
  judgeResponseSchema,
  type Assertion,
  type Criterion,
  type JudgeAssertion,
} from '../evaluation/schemas.ts';
import { hasDuplicates } from '../utils/index.ts';

export function validateJudgments(
  document: unknown,
  criteria: readonly Readonly<Criterion>[],
  responseSegments: readonly ResponseSegment[],
): Assertion[] {
  if (!judgeResponseSchema.validate(document))
    throw new Error('Judge response must contain only an array of well-formed assertions');
  return reconstructAssertions(document.assertions, criteria, responseSegments);
}

export function reconstructAssertions(
  judgments: readonly Readonly<JudgeAssertion>[],
  criteria: readonly Readonly<Criterion>[],
  responseSegments: readonly ResponseSegment[],
): Assertion[] {
  const expected = criteria.map((entry) => entry.id).sort();
  const actual = judgments.map((entry) => entry.id).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Judge assertion IDs are missing, duplicated, or unexpected');
  }

  const segments = new Map(responseSegments.map((line) => [line.id, line.text]));
  const judgmentsById = new Map(judgments.map((entry) => [entry.id, entry]));
  let evidenceBytes = 0;

  return criteria.map((criterion) => {
    const entry = judgmentsById.get(criterion.id)!;
    const ids = entry.evidence_ids;
    if (hasDuplicates(ids) || ids.some((id) => !segments.has(id))) {
      throw new Error('Judge evidence IDs are duplicated or unknown');
    }

    const texts = ids.map((id) => segments.get(id)!);
    evidenceBytes +=
      texts.reduce((total, text) => total + Buffer.byteLength(text), 0) +
      Math.max(0, texts.length - 1);
    if (evidenceBytes > 2_097_152) throw new Error('Reconstructed evidence exceeds 2 MiB per case');

    const evidence = texts.join('\n');
    if (criterion.required && entry.passed && !evidence.trim())
      throw new Error('Passing positive assertion requires evidence');

    return {
      ...criterion,
      id: criterion.id,
      passed: entry.passed,
      reason: entry.reason,
      evidence_ids: ids,
      evidence,
    };
  });
}
