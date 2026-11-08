import type { Criterion } from '../evaluation/index.ts';

import type { JudgeAssertionSchemaVariant, JudgeOutputSchema } from './types.ts';

export function judgeSchema(criteria: readonly Readonly<Criterion>[]): JudgeOutputSchema {
  if (criteria.length > 128) throw new Error('Case exceeds 128 criteria');
  const variants = criteria.flatMap((criterion) =>
    [true, false].map((passed): JudgeAssertionSchemaVariant => ({
      type: 'object',
      additionalProperties: false,
      required: ['id', 'passed', 'reason', 'evidence_ids'],
      properties: {
        id: { type: 'string', enum: [criterion.id] },
        passed: { type: 'boolean', enum: [passed] },
        reason: { type: 'string' },
        evidence_ids: {
          type: 'array',
          minItems: criterion.required && passed ? 1 : 0,
          items: { type: 'string' },
        },
      },
    })),
  );
  return {
    type: 'object',
    additionalProperties: false,
    required: ['assertions'],
    properties: { assertions: { type: 'array', items: { anyOf: variants } } },
  };
}
