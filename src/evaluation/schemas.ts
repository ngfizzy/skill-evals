import { z } from 'zod';

import { canonicalGitUrl } from '../sources/index.ts';

const LOWERCASE_SHA1_COMMIT_ID_PATTERN = /^[a-f0-9]{40}$/u;

const text = z.string();
const nonempty = text.refine((value) => value.trim().length > 0);
const count = z.int().nonnegative();

const gitSourceSchema = z.strictObject({
  url: text.refine((url) => {
    try {
      return canonicalGitUrl(url) === url;
    } catch {
      return false;
    }
  }),
  commit: text.regex(LOWERCASE_SHA1_COMMIT_ID_PATTERN),
});

const criterionSchema = z.object({
  id: nonempty,
  text: nonempty,
  required: z.boolean(),
});

const evaluationCaseSchema = z.object({
  key: text,
  skill: text,
  id: text,
  title: text,
  prompt: text,
  references: z.array(text).readonly().optional(),
  criteria: z.array(criterionSchema.readonly()).min(1).readonly(),
  source: text,
  source_sha256: text,
});

const judgeAssertionSchema = z.strictObject({
  id: text,
  passed: z.boolean(),
  reason: nonempty,
  evidence_ids: z.array(text).readonly(),
});

export const judgeResponseSchema = z.strictObject({
  assertions: z.array(judgeAssertionSchema),
});

const assertionSchema = z.object({
  ...judgeAssertionSchema.shape,
  ...criterionSchema.shape,
  evidence: text,
});

const caseResultSchema = evaluationCaseSchema.extend({
  context_mode: z.enum(['full', 'focused', 'full-fallback']).optional(),
  context_bytes: count.optional(),
  skill_sha256: text,
  candidate_input: text.optional(),
  skill_instructions: text.optional(),
  response: text.optional(),
  judgment: text.optional(),
  assertions: z.array(assertionSchema.readonly()).readonly().optional(),
  status: z.enum(['passed', 'failed', 'error']),
  score: z.number().nullable(),
  error: text.optional(),
  error_stage: z.enum(['candidate', 'judge', 'grading']).optional(),
});

export const reportSchema = z.object({
  version: z.literal(1),
  mode: z.literal('response-only'),
  evaluation_protocol: z.enum(['response-decisions-v3', 'response-decisions-v4']),
  started_at: text,
  finished_at: text.optional(),
  interrupted: z.boolean().optional(),
  agent_version: text,
  model: text,
  judge_model: text,
  timeout_seconds: z.int().positive(),
  context: z.enum(['full', 'focused']),
  reasoning_effort: text,
  judge_reasoning_effort: text,
  selected_cases: count,
  git_sources: z.array(gitSourceSchema.readonly()).readonly().optional(),
  results: z.array(caseResultSchema.readonly()).readonly(),
});

export type Criterion = z.infer<typeof criterionSchema>;
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type JudgeAssertion = z.infer<typeof judgeAssertionSchema>;
export type Judgment = JudgeAssertion & { evidence: string };
export type CaseResult = z.infer<typeof caseResultSchema>;
export type ReportData = z.infer<typeof reportSchema>;
