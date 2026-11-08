import type { Assertion, EvaluationCase } from '../evaluation/index.ts';

export interface JudgeInput {
  entry: Pick<EvaluationCase, 'prompt' | 'criteria'>;
  bundle: string;
  response: string;
  signal?: AbortSignal;
  onStart?: () => void;
}

export type JudgeOutcome =
  | { judgment: string; assertions: Assertion[] }
  | { stage: 'judge'; error: string }
  | { stage: 'grading'; error: string; judgment: string };

export interface JudgeOutputSchema {
  type: 'object';
  additionalProperties: false;
  required: ['assertions'];
  properties: {
    assertions: { type: 'array'; items: { anyOf: JudgeAssertionSchemaVariant[] } };
  };
}

export interface JudgeAssertionSchemaVariant {
  type: 'object';
  additionalProperties: false;
  required: ['id', 'passed', 'reason', 'evidence_ids'];
  properties: {
    id: { type: 'string'; enum: [string] };
    passed: { type: 'boolean'; enum: [boolean] };
    reason: { type: 'string' };
    evidence_ids: {
      type: 'array';
      minItems: 0 | 1;
      items: { type: 'string' };
    };
  };
}
